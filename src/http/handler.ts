import { randomBytes } from "node:crypto";
import { checkDomain } from "../core/check.js";
import type { RawResolver } from "../core/dns.js";
import { normalizeDomain } from "../core/normalize.js";
import { authenticate, extractKey, hasKeyInQuery } from "./auth.js";
import {
  chargeRateLimit,
  type DailyWindow,
  type RateLimits,
} from "./ratelimit.js";
import type { Store } from "./store/types.js";
import {
  logEvent,
  logRequest,
  recordSuccessfulCheck,
  type LogSink,
} from "./usage.js";

export interface HandlerConfig {
  resolver: RawResolver;
  /** AUTH-3, AUTH-6: SHA-256 hex of every valid key. Plaintext keys are never configured. */
  keyHashes: ReadonlySet<string>;
  limits: RateLimits;
  store: Store;
  log: LogSink;
  version: string;
  /** Injectable clock for rate-limit windows, timestamps and usage days. */
  now?: () => Date;
}

type ErrorCode =
  | "missing_domain"
  | "invalid_domain"
  | "key_in_query"
  | "missing_api_key"
  | "invalid_api_key"
  | "method_not_allowed"
  | "not_found"
  | "rate_limited"
  | "internal_error";

const CHECK_PATH = "/v1/domain/check";
const HEALTH_PATH = "/v1/health";
const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

/** HTTP-6: a client-supplied id is used only if it matches, otherwise 16 random bytes as hex. */
function pickRequestId(supplied: string | null): string {
  return supplied !== null && REQUEST_ID_PATTERN.test(supplied)
    ? supplied
    : randomBytes(16).toString("hex");
}

interface RequestState {
  requestId: string;
  head: boolean;
  endpoint: string;
  keyId: string | null;
  daily: DailyWindow | null;
  summaryStatus: string | null;
  dnsQueries: number;
}

function respond(
  state: RequestState,
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
): Response {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8", // HTTP-4
    "Cache-Control": "no-store", // HTTP-7
    "X-Request-Id": state.requestId, // HTTP-6
    ...extra,
  });
  if (state.daily) {
    // RL-3
    headers.set("X-RateLimit-Limit", String(state.daily.limit));
    headers.set("X-RateLimit-Remaining", String(state.daily.remaining));
    headers.set("X-RateLimit-Reset", String(state.daily.reset));
  }
  return new Response(state.head ? null : JSON.stringify(body), {
    status,
    headers,
  });
}

function fail(
  state: RequestState,
  status: number,
  code: ErrorCode,
  message: string,
  extra: Record<string, string> = {},
): Response {
  // HTTP-5
  return respond(
    state,
    status,
    { error: { code, message }, request_id: state.requestId },
    extra,
  );
}

/**
 * SPEC.md §8. Framework-agnostic: a Web-standard Request in, a Response out. Order for the
 * check endpoint (AUTH-7): method, key-in-query, auth, rate limit, input validation, check.
 */
export function createHandler(
  config: HandlerConfig,
): (request: Request) => Promise<Response> {
  const now = config.now ?? (() => new Date());

  async function dispatch(
    request: Request,
    state: RequestState,
  ): Promise<Response> {
    const url = new URL(request.url);
    const isRead = request.method === "GET" || request.method === "HEAD";

    if (url.pathname === HEALTH_PATH) {
      if (!isRead) {
        return fail(
          state,
          405,
          "method_not_allowed",
          "Use GET for this endpoint.",
          { Allow: "GET" },
        );
      }
      // HTTP-2: unauthenticated, no DNS.
      return respond(state, 200, { status: "ok", version: config.version });
    }

    if (url.pathname !== CHECK_PATH) {
      return fail(state, 404, "not_found", "No such endpoint."); // HTTP-3
    }
    state.endpoint = CHECK_PATH;

    if (!isRead) {
      return fail(
        state,
        405,
        "method_not_allowed",
        "Use GET for this endpoint.",
        { Allow: "GET" },
      ); // HTTP-1
    }

    if (hasKeyInQuery(url.searchParams)) {
      return fail(
        state,
        400,
        "key_in_query",
        "Send the API key in the Authorization header (Authorization: Bearer <key>) or the X-API-Key header, not in the URL, because URLs end up in logs.",
      );
    }

    const presented = extractKey(request.headers);
    if (presented === null) {
      return fail(
        state,
        401,
        "missing_api_key",
        "Send your API key as Authorization: Bearer <key> or in the X-API-Key header.",
        { "WWW-Authenticate": "Bearer" },
      );
    }
    const auth = authenticate(presented, config.keyHashes);
    if (auth === null) {
      return fail(state, 401, "invalid_api_key", "The API key is not valid.", {
        "WWW-Authenticate": "Bearer",
      });
    }
    state.keyId = auth.keyId;

    const limit = await chargeRateLimit(
      config.store,
      auth.keyId,
      config.limits,
      now(),
    );
    if (limit.storeUnavailable) {
      logEvent(config.log, now(), "store_unavailable", state.requestId);
    }
    state.daily = limit.daily;
    if (!limit.allowed) {
      return fail(
        state,
        429,
        "rate_limited",
        `Rate limit exceeded. Retry after ${limit.retryAfterSec} seconds.`,
        { "Retry-After": String(limit.retryAfterSec) },
      );
    }

    const normalized = normalizeDomain(url.searchParams.get("domain"));
    if (!normalized.ok) {
      return fail(state, 400, normalized.code, normalized.message);
    }

    const { result, dnsQueries } = await checkDomain(
      normalized.domain,
      config.resolver,
      { now, requestId: state.requestId },
    );
    state.dnsQueries = dnsQueries;
    state.summaryStatus = result.summary.status;
    await recordSuccessfulCheck(config.store, auth.keyId, now(), () =>
      logEvent(config.log, now(), "usage_write_failed", state.requestId),
    );
    return respond(state, 200, result); // HTTP-9
  }

  return async function handle(request: Request): Promise<Response> {
    const started = performance.now();
    const state: RequestState = {
      requestId: pickRequestId(request.headers.get("x-request-id")),
      head: request.method === "HEAD",
      endpoint: new URL(request.url).pathname,
      keyId: null,
      daily: null,
      summaryStatus: null,
      dnsQueries: 0,
    };

    let response: Response;
    try {
      response = await dispatch(request, state);
    } catch {
      // HTTP-8: nothing about the failure reaches the response or the log.
      logEvent(config.log, now(), "internal_error", state.requestId);
      response = fail(
        state,
        500,
        "internal_error",
        "Something went wrong on our side. Try again later.",
      );
    }

    if (state.keyId !== null) {
      logRequest(config.log, now(), {
        requestId: state.requestId,
        keyId: state.keyId,
        endpoint: state.endpoint,
        status: response.status,
        summaryStatus: state.summaryStatus,
        latencyMs: Math.round(performance.now() - started),
        dnsQueries: state.dnsQueries,
      });
    }
    return response;
  };
}
