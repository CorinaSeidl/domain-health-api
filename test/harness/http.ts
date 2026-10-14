import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { createHandler, type HandlerConfig } from "../../src/http/handler.js";
import { MemoryStore } from "../../src/http/store/memory.js";
import type { Store } from "../../src/http/store/types.js";
import { VERSION } from "../../src/version.js";
import { fakeResolver, type Zone } from "./fake-dns.js";
import { loadVectors } from "./vectors.js";
import { responseValidator, schemaValidator } from "./openapi.js";

type Validator = (data: unknown) => string | null;
const validators = new Map<string, Validator>();
function cached(key: string, build: () => Validator): Validator {
  let v = validators.get(key);
  if (!v) {
    v = build();
    validators.set(key, v);
  }
  return v;
}

/** http.json: "one valid key K1 = 'dh_' + 32 base62 chars whose SHA-256 is in API_KEY_HASHES". */
export const K1 = "dh_" + "aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD2fH".slice(0, 32);
export const K2 = "dh_" + "Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp".slice(0, 32);
export const sha256 = (v: string) =>
  createHash("sha256").update(v).digest("hex");

/** Fully configured example.com: valid SPF, DMARC and MX. */
export const GOOD_ZONE: Zone = {
  "example.com": {
    TXT: [["v=spf1 -all"]],
    MX: [{ priority: 10, exchange: "mx.example.com" }],
  },
  "_dmarc.example.com": {
    TXT: [["v=DMARC1; p=reject; rua=mailto:r@example.com"]],
  },
  "mx.example.com": { A: ["192.0.2.10"] },
};

export const START = Date.UTC(2026, 9, 13, 8, 0, 0);

export interface AppOptions {
  zone?: Zone;
  keys?: string[];
  limits?: { perMinute: number; perDay: number };
  store?: Store;
  resolver?: HandlerConfig["resolver"];
  start?: number;
}

/** Handler under test plus a controllable clock and captured log lines. */
export function makeApp(options: AppOptions = {}) {
  let clock = options.start ?? START;
  const now = () => new Date(clock);
  const resolver = fakeResolver(options.zone ?? GOOD_ZONE);
  const store = new MemoryStore(() => clock);
  const logs: string[] = [];
  const handle = createHandler({
    resolver: options.resolver ?? resolver,
    keyHashes: new Set((options.keys ?? [K1]).map(sha256)),
    limits: options.limits ?? { perMinute: 10, perDay: 200 },
    store: options.store ?? store,
    log: (line) => logs.push(line),
    version: VERSION,
    now,
  });

  /**
   * Sends a request and validates the JSON body against openapi.yaml (Acceptance #3): 200 uses
   * the declared success schema for the path, every other status uses the Error schema.
   */
  async function request(
    path: string,
    init: {
      method?: string;
      headers?: Record<string, string>;
      key?: string | null;
      body?: string;
    } = {},
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    const key = init.key === undefined ? K1 : init.key;
    if (
      key !== null &&
      !headers.has("authorization") &&
      !headers.has("x-api-key")
    ) {
      headers.set("authorization", `Bearer ${key}`);
    }
    const method = init.method ?? "GET";
    const res = await handle(
      new Request(`https://api.test${path}`, {
        method,
        headers,
        ...(init.body === undefined ? {} : { body: init.body }),
      }),
    );
    const isHtml = res.headers.get("content-type")?.startsWith("text/html");
    if (method !== "HEAD" && !isHtml) {
      const body: unknown = await res.clone().json();
      const route = path.split("?")[0] ?? path;
      const success = res.status === 200 || res.status === 201;
      const validate = success
        ? cached(`${method} ${route} ${res.status}`, () =>
            responseValidator(route, method.toLowerCase(), res.status),
          )
        : cached("Error", () => schemaValidator("Error"));
      expect(
        validate(body),
        `openapi: ${method} ${path} -> ${res.status}`,
      ).toBeNull();
    }
    return res;
  }

  return {
    request,
    handle,
    /** KEY-1: POST /v1/keys with a JSON email body. No API key is sent. */
    signup: (email: unknown, init: { headers?: Record<string, string> } = {}) =>
      request("/v1/keys", {
        method: "POST",
        key: null,
        body: JSON.stringify({ email }),
        ...init,
      }),
    check: (domain: string, init?: Parameters<typeof request>[1]) =>
      request(`/v1/domain/check?domain=${encodeURIComponent(domain)}`, init),
    resolver,
    store,
    logs,
    parsedLogs: () => logs.map((l) => JSON.parse(l) as Record<string, unknown>),
    advance: (ms: number) => {
      clock += ms;
    },
    setTime: (ms: number) => {
      clock = ms;
    },
  };
}

interface HttpScenario {
  id: string;
  rules: string[];
}

const scenarios = new Map(
  loadVectors("http.json").map((v) => [v.id, v as HttpScenario]),
);

function title(id: string, description: string): string {
  const v = scenarios.get(id);
  if (!v) throw new Error(`${id} is not in spec/vectors/http.json`);
  return `${id} [${v.rules.join(", ")}] ${description}`;
}

/** One hand-written test per http.json scenario, named with its id (vectors/README.md). */
export function scenario(
  id: string,
  description: string,
  fn: () => void | Promise<void>,
): void {
  it(title(id, description), fn);
}

/** A scenario whose real test lands with a later milestone. Not coverage: see the PR notes. */
scenario.todo = (id: string, description: string): void => {
  it.todo(title(id, description));
};

export const HEX32 = /^[0-9a-f]{32}$/;
