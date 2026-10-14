import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  loadUsageSource,
  main as usageReport,
} from "../scripts/usage-report.js";
import { hashKey, keyIdOf } from "../src/http/auth.js";
import { handle } from "../src/http/vercel.js";
import { createStore } from "../src/http/store/index.js";
import { MemoryStore } from "../src/http/store/memory.js";
import {
  UpstashStore,
  upstashConfigFromEnv,
  USAGE_RETENTION_DAYS,
} from "../src/http/store/upstash.js";
import { FAKE_TOKEN, FAKE_URL, fakeUpstash } from "./harness/upstash.js";
import { K1, makeApp, START } from "./harness/http.js";

const config = { url: FAKE_URL, token: FAKE_TOKEN };
const DAY_MS = 86_400_000;

function setup(start = START) {
  let clock = start;
  const fake = fakeUpstash(() => clock);
  const store = new UpstashStore(config, fake.fetch, () => clock);
  return { fake, store, setClock: (ms: number) => (clock = ms) };
}

describe("Upstash credentials (D-1)", () => {
  it("prefers UPSTASH_REDIS_REST_* and falls back to KV_REST_API_*", () => {
    expect(
      upstashConfigFromEnv({
        UPSTASH_REDIS_REST_URL: "https://a.test/",
        UPSTASH_REDIS_REST_TOKEN: "ta",
        KV_REST_API_URL: "https://b.test",
        KV_REST_API_TOKEN: "tb",
      }),
    ).toEqual({ url: "https://a.test", token: "ta" });
    expect(
      upstashConfigFromEnv({
        KV_REST_API_URL: "https://b.test",
        KV_REST_API_TOKEN: "tb",
      }),
    ).toEqual({ url: "https://b.test", token: "tb" });
  });

  it("needs both halves of a pair", () => {
    expect(
      upstashConfigFromEnv({ UPSTASH_REDIS_REST_URL: "https://a.test" }),
    ).toBeNull();
    expect(upstashConfigFromEnv({ KV_REST_API_TOKEN: "tb" })).toBeNull();
    expect(upstashConfigFromEnv({})).toBeNull();
    // A complete second pair is used when the first is partial.
    expect(
      upstashConfigFromEnv({
        UPSTASH_REDIS_REST_URL: "https://a.test",
        KV_REST_API_URL: "https://b.test",
        KV_REST_API_TOKEN: "tb",
      }),
    ).toEqual({ url: "https://b.test", token: "tb" });
  });
});

describe("createStore fallback (RL-4)", () => {
  it("RL-4 uses the memory store and logs store_unconfigured once when nothing is set", () => {
    const logs: string[] = [];
    const store = createStore({}, (l) => logs.push(l), {
      now: () => new Date(START),
    });
    expect(store).toBeInstanceOf(MemoryStore);
    expect(logs.map((l) => JSON.parse(l))).toEqual([
      { event: "store_unconfigured", ts: new Date(START).toISOString() },
    ]);
  });

  it("uses Upstash and logs nothing when credentials are set", () => {
    const logs: string[] = [];
    const store = createStore(
      { KV_REST_API_URL: FAKE_URL, KV_REST_API_TOKEN: FAKE_TOKEN },
      (l) => logs.push(l),
      { fetch: fakeUpstash().fetch },
    );
    expect(store).toBeInstanceOf(UpstashStore);
    expect(logs).toEqual([]);
  });
});

describe("UpstashStore counters (RL-1, RL-4)", () => {
  it("RL-1 INCR and EXPIREAT travel in one MULTI/EXEC request with the bearer token", async () => {
    const { fake, store } = setup();
    const expiresAt = Math.floor(START / 1000) + 60;
    expect(await store.increment("rl:m:k:1", expiresAt)).toBe(1);
    expect(await store.increment("rl:m:k:1", expiresAt)).toBe(2);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]).toEqual({
      path: "/multi-exec",
      commands: [
        ["INCR", "rl:m:k:1"],
        ["EXPIREAT", "rl:m:k:1", expiresAt],
      ],
    });
    expect(await store.get("rl:m:k:1")).toBe(2);
    expect(await store.get("rl:m:absent")).toBe(0);
  });

  it("RL-1 concurrent increments never share a value", async () => {
    const { store } = setup();
    const values = await Promise.all(
      Array.from({ length: 50 }, () =>
        store.increment("c", Math.floor(START / 1000) + 60),
      ),
    );
    expect([...values].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 50 }, (_, i) => i + 1),
    );
  });

  it("RL-1 a counter expires with its window", async () => {
    const { store, setClock } = setup();
    await store.increment("w", Math.floor(START / 1000) + 60);
    setClock(START + 61_000);
    expect(await store.get("w")).toBe(0);
    expect(await store.increment("w", Math.floor(START / 1000) + 120)).toBe(1);
  });

  it("RL-1 and RL-2 the handler enforces 10 per minute through the Upstash store", async () => {
    const { store } = setup();
    const app = makeApp({ store });
    for (let i = 0; i < 10; i++)
      expect((await app.check("example.com")).status).toBe(200);
    const res = await app.check("example.com");
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    // The counters are shared by every instance that talks to the same store.
    const other = makeApp({ store });
    expect((await other.check("example.com")).status).toBe(429);
  });
});

describe("UpstashStore self-serve keys (KEY-3, KEY-5)", () => {
  const record = (
    email: string | null,
    keyHash = hashKey(`dh_${"a".repeat(32)}`),
  ) => ({
    keyHash,
    keyId: keyIdOf(keyHash),
    email,
    createdAt: new Date(START).toISOString(),
    status: "active" as const,
  });

  it("KEY-5 stores the record under its hash and reads it back", async () => {
    const { store } = setup();
    const r = record("dev@example.com");
    await store.createKey(r);
    expect(await store.getKey(r.keyHash)).toEqual(r);
    expect(await store.getKey(hashKey("dh_other"))).toBeNull();
    const noEmail = record(null, hashKey(`dh_${"c".repeat(32)}`));
    await store.createKey(noEmail);
    expect(await store.getKey(noEmail.keyHash)).toEqual(noEmail);
  });

  it("KEY-3 a second key for the same email is stored too, with no per-email index", async () => {
    const { store, fake } = setup();
    const first = record("dev@example.com");
    const second = record("dev@example.com", hashKey(`dh_${"b".repeat(32)}`));
    await store.createKey(first);
    await store.createKey(second);
    expect(await store.getKey(first.keyHash)).toEqual(first);
    expect(await store.getKey(second.keyHash)).toEqual(second);
    expect([...fake.strings.keys()].sort()).toEqual(
      [`key:h:${first.keyHash}`, `key:h:${second.keyHash}`].sort(),
    );
  });

  it("KEY-5 store keys use hashes, never the plaintext key or the raw email", async () => {
    const { store, fake } = setup();
    const r = record("Private.Person@example.com".toLowerCase());
    await store.createKey(r);
    const names = [...fake.strings.keys()];
    expect(names.every((k) => /^key:h:[0-9a-f]{64}$/.test(k))).toBe(true);
    expect(names.join(" ")).not.toContain("private");
  });

  it("KEY-3 and AUTH-6 two instances sharing the store both accept a key issued by either", async () => {
    const { store } = setup();
    const a = makeApp({ store });
    const b = makeApp({ store });
    const issued = (await (await a.signup("dev@example.com")).json()) as {
      api_key: string;
    };
    expect((await b.signup("dev@example.com")).status).toBe(201);
    expect((await b.check("example.com", { key: issued.api_key })).status).toBe(
      200,
    );
  });

  it("KEY-4 the signup throttle is shared through the store and carries only a hash of the IP", async () => {
    const { store, fake } = setup();
    const ip = "203.0.113.50";
    const headers = { "x-real-ip": ip };
    const a = makeApp({ store });
    const b = makeApp({ store });
    for (let i = 0; i < 5; i++) {
      await (i % 2 ? a : b).signup(`dev${i}@example.com`, { headers });
    }
    expect((await a.signup("x@example.com", { headers })).status).toBe(429);
    expect(JSON.stringify(fake.calls)).not.toContain(ip);
    expect([...fake.expiry.keys()].some((k) => k.startsWith("ks:"))).toBe(true);
  });

  it("KEY-1 a store outage while issuing a key is a 500 that leaks nothing", async () => {
    const { store, fake } = setup();
    const app = makeApp({ store });
    fake.state.failWith = "network";
    const res = await app.signup("dev@example.com");
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain(FAKE_TOKEN);
  });
});

describe("UpstashStore usage (USE-3)", () => {
  it("USE-3 counts successful checks per key per day, and a counted day is an active day", async () => {
    const { store } = setup(START + 30 * DAY_MS);
    for (const [key, day] of [
      ["k1", "2026-10-13"],
      ["k1", "2026-10-13"],
      ["k1", "2026-10-13"],
      ["k1", "2026-10-15"],
      ["k2", "2026-10-14"],
    ] as const) {
      await store.recordSuccess(key, day);
    }
    expect(await store.listUsage()).toEqual([
      { keyId: "k1", counts: { "2026-10-13": 3, "2026-10-15": 1 } },
      { keyId: "k2", counts: { "2026-10-14": 1 } },
    ]);
  });

  it("USE-3 keeps usage for at least 90 days and then drops it", async () => {
    const { fake, store, setClock } = setup();
    await store.recordSuccess("k1", "2026-10-13");
    const dayStart = Date.parse("2026-10-13T00:00:00Z") / 1000;
    expect(USAGE_RETENTION_DAYS).toBeGreaterThanOrEqual(90);
    for (const key of ["usage:c:k1:2026-10-13", "usage:d:2026-10-13"]) {
      expect(fake.expiry.get(key)! - dayStart).toBeGreaterThanOrEqual(
        90 * 86_400,
      );
    }
    setClock(START + 60 * DAY_MS);
    expect(await store.listUsage()).toHaveLength(1); // day 60: still there
    setClock(START + 90 * DAY_MS);
    expect(await store.listUsage()).toHaveLength(1); // day 90: still there
    setClock(START + 103 * DAY_MS);
    expect(await store.listUsage()).toEqual([]);
  });

  it("USE-3 usage keys contain only the key_id and the day", async () => {
    const { fake, store } = setup();
    await store.recordSuccess("abcdef123456", "2026-10-13");
    const written = JSON.stringify(fake.calls);
    expect(written).not.toContain(K1);
    expect(written).not.toContain(FAKE_TOKEN);
  });

  it("USE-4 the report reads the Upstash store", async () => {
    // usage-report builds its own store on the real clock, so seed days relative to now.
    const day = (ago: number) =>
      new Date(Date.now() - ago * DAY_MS).toISOString().slice(0, 10);
    const { fake, store } = setup(Date.now());
    await store.recordSuccess("k1", day(2));
    await store.recordSuccess("k1", day(1));
    await store.recordSuccess("k2", day(1));
    const lines: string[] = [];
    await usageReport(
      ["--from", day(3), "--to", day(0)],
      (l) => lines.push(l),
      {
        UPSTASH_REDIS_REST_URL: FAKE_URL,
        UPSTASH_REDIS_REST_TOKEN: FAKE_TOKEN,
      },
      fake.fetch,
    );
    const out = lines.join("\n");
    expect(out).toContain("Unique active keys: 2");
    expect(out).toContain("Total successful checks: 3");
    expect(out).toContain("Repeat keys (active on 2 or more distinct days): 1");
  });
});

describe("failures fail open (RL-4, USE-5)", () => {
  for (const mode of ["http", "network", "command"] as const) {
    it(`RL-4 and USE-5 a ${mode} failure rejects without leaking the token, and requests still succeed`, async () => {
      const { fake, store } = setup();
      fake.state.failWith = mode;
      const error = await store.increment("x", 1).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(String((error as Error).message)).not.toContain(FAKE_TOKEN);
      await expect(store.recordSuccess("k", "2026-10-13")).rejects.toThrow();
      await expect(store.listUsage()).rejects.toThrow();

      const app = makeApp({ store });
      const res = await app.check("example.com");
      expect(res.status).toBe(200);
      expect(res.headers.get("x-ratelimit-limit")).toBeNull();
      const events = app.parsedLogs().map((l) => l["event"]);
      expect(events).toContain("store_unavailable");
      expect(events).toContain("usage_write_failed");
      expect(app.logs.join("\n")).not.toContain(FAKE_TOKEN);
    });
  }

  it("a wrong token is rejected by the fake like the real API", async () => {
    const fake = fakeUpstash();
    const store = new UpstashStore(
      { url: FAKE_URL, token: "wrong" },
      fake.fetch,
    );
    await expect(store.get("x")).rejects.toThrow("HTTP 401");
  });
});

describe("usage-report source", () => {
  it("USE-4 --usage-file wins over the environment", async () => {
    const dir = mkdtempSync(join(tmpdir(), "usage-"));
    const file = join(dir, "u.json");
    writeFileSync(
      file,
      JSON.stringify([{ keyId: "a", counts: { "2026-10-13": 2 } }]),
    );
    const source = loadUsageSource(file, {
      UPSTASH_REDIS_REST_URL: FAKE_URL,
      UPSTASH_REDIS_REST_TOKEN: FAKE_TOKEN,
    });
    expect(await source.listUsage()).toEqual([
      { keyId: "a", counts: { "2026-10-13": 2 } },
    ]);
  });

  it("USE-4 explains what to set when there is no usage source", () => {
    expect(() => loadUsageSource(undefined, {})).toThrow(
      "UPSTASH_REDIS_REST_URL",
    );
  });
});

describe("Vercel config (HTTP-3)", () => {
  const vercel = JSON.parse(
    readFileSync(new URL("../vercel.json", import.meta.url), "utf8"),
  ) as {
    rewrites: { source: string; destination: string }[];
  };
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as {
    engines: { node: string };
  };

  it("rewrites the public paths to the functions, then everything else to the 404 function", () => {
    expect(vercel.rewrites.map((r) => [r.source, r.destination])).toEqual([
      ["/v1/domain/check", "/api/v1/domain/check"],
      ["/v1/health", "/api/v1/health"],
      ["/v1/keys", "/api/v1/keys"],
      ["/", "/api/index"],
      ["/((?!api/).*)", "/api/not-found"],
    ]);
    // Rewrites apply in order, so "/" reaches the landing page before this pattern sees it.
    const catchAll = new RegExp(`^${vercel.rewrites[4]!.source}$`);
    for (const path of [
      "/",
      "/nope",
      "/v1/domain/check/extra",
      "/v2/domain/check",
    ]) {
      expect(catchAll.test(path), path).toBe(true);
    }
    for (const path of [
      "/api/v1/health",
      "/api/v1/domain/check",
      "/api/not-found",
    ]) {
      expect(catchAll.test(path), path).toBe(false);
    }
  });

  it("pins Node 22 (Vercel reads the version from engines, not vercel.json)", () => {
    expect(pkg.engines.node).toBe("22.x");
  });

  it("LP-1 the landing function serves the page at the host it was reached on", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await handle(
      new Request("https://checks.example.org/api/index"),
    );
    log.mockRestore();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toContain(
      'curl -s "https://checks.example.org/v1/domain/check?domain=example.com"',
    );
  });

  it("KEY-1 the keys function issues a key", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await handle(
      new Request("https://api.test/api/v1/keys", {
        method: "POST",
        body: JSON.stringify({ email: "adapter@example.com" }),
      }),
    );
    log.mockRestore();
    expect(res.status).toBe(201);
    expect(((await res.json()) as { api_key: string }).api_key).toMatch(
      /^dh_[0-9A-Za-z]{32}$/,
    );
  });

  it("HTTP-3 the not-found function answers with the JSON error envelope", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await handle(new Request("https://api.test/api/not-found"));
    log.mockRestore();
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });
});
