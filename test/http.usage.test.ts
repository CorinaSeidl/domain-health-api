import { describe, expect } from "vitest";
import { buildUsageReport } from "../scripts/usage-report.js";
import { MemoryStore } from "../src/http/store/memory.js";
import { K1, makeApp, scenario, START } from "./harness/http.js";

const DAY = 24 * 60 * 60 * 1000;

describe("Usage tracking (SPEC.md §8.5)", () => {
  scenario(
    "H-29",
    "no log line contains the domain, the key, the client IP or the Authorization header",
    async () => {
      const app = makeApp({ limits: { perMinute: 2, perDay: 200 } });
      const headers = {
        "x-forwarded-for": "203.0.113.9",
        "x-real-ip": "203.0.113.9",
      };
      const domain = "secretclient-example.com";
      await app.check(domain, { headers }); // 200
      await app.check("http://secretclient-example.com", { headers }); // 400
      await app.check(domain, { headers }); // 429
      await app.check(domain, { headers, key: null }); // 401
      const out = app.logs.join("\n");
      expect(out).not.toBe("");
      for (const secret of ["secretclient", K1, "203.0.113.9", "Bearer"]) {
        expect(out).not.toContain(secret);
      }
      // 500 path too.
      const boom = () =>
        Promise.reject(new TypeError(`bug while checking ${domain}`));
      const crashing = makeApp({
        resolver: {
          resolveTxt: boom,
          resolveMx: boom,
          resolve4: boom,
          resolve6: boom,
        },
      });
      expect((await crashing.check(domain, { headers })).status).toBe(500);
      const crashLogs = crashing.logs.join("\n");
      expect(crashLogs).not.toBe("");
      for (const secret of ["secretclient", K1, "203.0.113.9", "Bearer"]) {
        expect(crashLogs).not.toContain(secret);
      }
    },
  );

  scenario(
    "H-30",
    "the store counts only successful checks per key per UTC day",
    async () => {
      const app = makeApp();
      const day1 = START;
      const day3 = START + 2 * DAY;
      app.setTime(day1);
      for (let i = 0; i < 3; i++)
        expect((await app.check("example.com")).status).toBe(200);
      expect((await app.check("http://example.com")).status).toBe(400);
      app.setTime(day3);
      for (let i = 0; i < 2; i++)
        expect((await app.check("example.com")).status).toBe(200);
      const usage = await app.store.listUsage();
      expect(usage).toHaveLength(1);
      expect(usage[0]!.counts).toEqual({ "2026-10-13": 3, "2026-10-15": 2 });
      expect(Object.keys(usage[0]!.counts)).toEqual([
        "2026-10-13",
        "2026-10-15",
      ]);
    },
  );

  scenario(
    "H-31",
    "usage-report counts unique keys, repeat keys and total successful checks",
    async () => {
      const store = new MemoryStore();
      const day = (n: number) => `2026-10-0${n}`;
      await store.recordSuccess("K1", day(1));
      await store.recordSuccess("K1", day(3));
      await store.recordSuccess("K2", day(2));
      await store.recordSuccess("K3", day(2));
      await store.recordSuccess("K3", day(2));
      expect(await buildUsageReport(store, day(1), day(7))).toEqual({
        from: day(1),
        to: day(7),
        uniqueActiveKeys: 3,
        totalSuccessfulChecks: 5,
        repeatKeys: 1,
      });
    },
  );
});
