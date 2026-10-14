import { describe, expect } from "vitest";
import type { KeyRecord, KeyUsage, Store } from "../src/http/store/types.js";
import { K1, K2, makeApp, scenario, START } from "./harness/http.js";

const midnightAfter = (ms: number) => {
  const d = new Date(ms);
  return (
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) / 1000
  );
};

class ThrowingStore implements Store {
  private fail(): never {
    throw new Error("store is down");
  }
  increment(): Promise<number> {
    return this.fail();
  }
  get(): Promise<number> {
    return this.fail();
  }
  recordSuccess(): Promise<void> {
    return this.fail();
  }
  listUsage(): Promise<KeyUsage[]> {
    return this.fail();
  }
  createKey(): Promise<void> {
    return this.fail();
  }
  getKey(): Promise<KeyRecord | null> {
    return this.fail();
  }
}

describe("Rate limiting (SPEC.md §8.4)", () => {
  scenario(
    "H-21",
    "invalid-input requests are charged against the limit",
    async () => {
      const app = makeApp();
      for (let i = 0; i < 10; i++) {
        expect((await app.check("http://example.com")).status).toBe(400);
      }
      expect((await app.check("example.com")).status).toBe(429);
    },
  );

  scenario(
    "H-22",
    "the 11th request in a minute is 429 with Retry-After in 1..60",
    async () => {
      const app = makeApp();
      for (let i = 0; i < 10; i++) {
        expect((await app.check("example.com")).status).toBe(200);
      }
      const res = await app.check("example.com");
      expect(res.status).toBe(429);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("rate_limited");
      const retry = Number(res.headers.get("retry-after"));
      expect(Number.isInteger(retry)).toBe(true);
      expect(retry).toBeGreaterThanOrEqual(1);
      expect(retry).toBeLessThanOrEqual(60);
    },
  );

  scenario("H-23", "the limit clears after the minute passes", async () => {
    const app = makeApp();
    for (let i = 0; i < 11; i++) await app.check("example.com");
    app.advance(61_000);
    expect((await app.check("example.com")).status).toBe(200);
  });

  scenario(
    "H-24",
    "the 201st request in a UTC day is 429 and Retry-After runs to midnight",
    async () => {
      const app = makeApp();
      for (let minute = 0; minute < 20; minute++) {
        for (let i = 0; i < 10; i++) {
          expect((await app.check("example.com")).status).toBe(200);
        }
        app.advance(60_000);
      }
      const now = START + 20 * 60_000;
      const res = await app.check("example.com");
      expect(res.status).toBe(429);
      const retry = Number(res.headers.get("retry-after"));
      expect(
        Math.abs(retry - (midnightAfter(now) - now / 1000)),
      ).toBeLessThanOrEqual(1);
    },
  );

  scenario("H-25", "limits are per key", async () => {
    const app = makeApp({ keys: [K1, K2] });
    for (const key of [K1, K2]) {
      for (let i = 0; i < 10; i++) {
        expect((await app.check("example.com", { key })).status).toBe(200);
      }
    }
  });

  scenario("H-26", "limits come from config", async () => {
    const app = makeApp({ limits: { perMinute: 3, perDay: 200 } });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++)
      statuses.push((await app.check("example.com")).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  scenario(
    "H-27",
    "daily X-RateLimit-* headers are on 200, 400 and 429 for authenticated callers",
    async () => {
      const app = makeApp({ limits: { perMinute: 3, perDay: 200 } });
      const reset = String(midnightAfter(START));
      const first = await app.check("example.com");
      const second = await app.check("example.com");
      for (const [res, remaining] of [
        [first, "199"],
        [second, "198"],
      ] as const) {
        expect(res.headers.get("x-ratelimit-limit")).toBe("200");
        expect(res.headers.get("x-ratelimit-remaining")).toBe(remaining);
        expect(res.headers.get("x-ratelimit-reset")).toBe(reset);
      }
      const bad = await app.check("http://example.com");
      expect(bad.status).toBe(400);
      expect(bad.headers.get("x-ratelimit-limit")).toBe("200");
      expect(bad.headers.get("x-ratelimit-remaining")).toBe("197");
      expect(bad.headers.get("x-ratelimit-reset")).toBe(reset);
      const limited = await app.check("example.com");
      expect(limited.status).toBe(429);
      expect(limited.headers.get("x-ratelimit-limit")).toBe("200");
      expect(limited.headers.get("x-ratelimit-remaining")).toBe("197");
      expect(limited.headers.get("x-ratelimit-reset")).toBe(reset);
    },
  );

  scenario(
    "H-28",
    "a failing store fails open: 200, store_unavailable and usage_write_failed logged, no rate-limit headers",
    async () => {
      const app = makeApp({ store: new ThrowingStore() });
      const res = await app.check("example.com");
      expect(res.status).toBe(200);
      for (const name of ["limit", "remaining", "reset"]) {
        expect(res.headers.get(`x-ratelimit-${name}`)).toBeNull();
      }
      const events = app.parsedLogs().map((l) => l["event"]);
      expect(events).toContain("store_unavailable");
      expect(events).toContain("usage_write_failed");
      expect(events.filter((e) => e === "request")).toHaveLength(1);
    },
  );
});
