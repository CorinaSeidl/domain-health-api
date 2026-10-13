import type { Store } from "./store/types.js";
import { utcDay } from "./ratelimit.js";

/** Log sink. The handler passes one JSON string per line; the adapter writes it to stdout. */
export type LogSink = (line: string) => void;

export interface RequestLogFields {
  requestId: string;
  keyId: string;
  endpoint: string;
  status: number;
  summaryStatus: string | null;
  latencyMs: number;
  dnsQueries: number;
}

/**
 * USE-1. The fields are an allowlist: nothing else may reach a log line (USE-2). In particular
 * the queried domain, the raw key, the client IP and the Authorization header never appear.
 */
export function logRequest(log: LogSink, now: Date, f: RequestLogFields): void {
  log(
    JSON.stringify({
      event: "request",
      ts: now.toISOString(),
      request_id: f.requestId,
      key_id: f.keyId,
      endpoint: f.endpoint,
      status: f.status,
      summary_status: f.summaryStatus,
      latency_ms: f.latencyMs,
      dns_queries: f.dnsQueries,
    }),
  );
}

/** Operational events (RL-4, USE-5, HTTP-8). They carry a request id only. */
export function logEvent(
  log: LogSink,
  now: Date,
  event: "store_unavailable" | "usage_write_failed" | "internal_error",
  requestId: string,
): void {
  log(JSON.stringify({ event, ts: now.toISOString(), request_id: requestId }));
}

/** USE-3 and USE-5: a failed usage write never fails the request. */
export async function recordSuccessfulCheck(
  store: Store,
  keyId: string,
  now: Date,
  onFailure: () => void,
): Promise<void> {
  try {
    await store.recordSuccess(keyId, utcDay(now));
  } catch {
    onFailure();
  }
}
