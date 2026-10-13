import { describe, expect } from "vitest";
import { hashKey, parseKeyHashes } from "../src/http/auth.js";
import { K1, makeApp, scenario, sha256 } from "./harness/http.js";

const PATH = "/v1/domain/check?domain=example.com";

describe("Authentication (SPEC.md §8.3)", () => {
  scenario(
    "H-12",
    "no key at all is 401 missing_api_key with WWW-Authenticate",
    async () => {
      const res = await makeApp().request(PATH, { key: null });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe("Bearer");
      expect(
        ((await res.json()) as { error: { code: string } }).error.code,
      ).toBe("missing_api_key");
    },
  );

  scenario(
    "H-13",
    "X-API-Key is accepted in place of Authorization",
    async () => {
      const res = await makeApp().request(PATH, {
        key: null,
        headers: { "x-api-key": K1 },
      });
      expect(res.status).toBe(200);
    },
  );

  scenario(
    "H-14",
    "an unknown key is 401 invalid_api_key with WWW-Authenticate",
    async () => {
      const res = await makeApp().request(PATH, {
        headers: {
          authorization: "Bearer dh_wrongwrongwrongwrongwrongwrongwr",
        },
      });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe("Bearer");
      expect(
        ((await res.json()) as { error: { code: string } }).error.code,
      ).toBe("invalid_api_key");
    },
  );

  scenario(
    "H-15",
    "a key in the query string is 400 key_in_query, even with no header",
    async () => {
      const res = await makeApp().request(`${PATH}&api_key=${K1}`, {
        key: null,
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: { code: string; message: string };
      };
      expect(body.error.code).toBe("key_in_query");
      expect(body.error.message).toContain("Authorization header");
    },
  );

  scenario(
    "H-16",
    "key_in_query wins over a valid header key, uncounted and without rate-limit headers",
    async () => {
      const app = makeApp({ limits: { perMinute: 1, perDay: 200 } });
      const res = await app.request(`${PATH}&key=${K1}`);
      expect(res.status).toBe(400);
      expect(
        ((await res.json()) as { error: { code: string } }).error.code,
      ).toBe("key_in_query");
      expect(res.headers.get("x-ratelimit-limit")).toBeNull();
      // AUTH-7: it was not charged, so the single allowed request still succeeds.
      expect((await app.check("example.com")).status).toBe(200);
    },
  );

  scenario.todo(
    "H-17",
    "scripts/issue-key output format (M3: AUTH-2 and AUTH-6 are not covered until then)",
  );

  scenario(
    "H-18",
    "only hashes are configured, stored or logged, and a hash is not a usable key",
    async () => {
      const app = makeApp();
      expect((await app.check("example.com")).status).toBe(200);
      expect(app.store.snapshot()).not.toContain(K1);
      expect(app.logs.join("\n")).not.toContain(K1);
      // A plaintext key in the key source is ignored; only 64-hex hashes are loaded.
      expect(parseKeyHashes(K1).size).toBe(0);
      expect(
        parseKeyHashes(
          ` ${sha256(K1)} , nonsense,${sha256("x").toUpperCase()}`,
        ),
      ).toEqual(new Set([sha256(K1), sha256("x")]));
      // Presenting the stored hash itself must not authenticate.
      const res = await app.check("example.com", {
        headers: { authorization: `Bearer ${hashKey(K1)}` },
      });
      expect(res.status).toBe(401);
    },
  );

  scenario(
    "H-19",
    "a successful request logs exactly one request line keyed by key_id",
    async () => {
      const app = makeApp();
      await app.check("example.com");
      const lines = app.parsedLogs();
      expect(lines).toHaveLength(1);
      const line = lines[0]!;
      expect(line["event"]).toBe("request");
      expect(line["key_id"]).toBe(sha256(K1).slice(0, 12));
      expect(Object.keys(line).sort()).toEqual(
        [
          "dns_queries",
          "endpoint",
          "event",
          "key_id",
          "latency_ms",
          "request_id",
          "status",
          "summary_status",
          "ts",
        ].sort(),
      );
      expect(line["status"]).toBe(200);
      expect(line["endpoint"]).toBe("/v1/domain/check");
      expect(typeof line["summary_status"]).toBe("string");
      expect(line["dns_queries"]).toBeGreaterThan(0);
      expect(typeof line["latency_ms"]).toBe("number");
      expect(typeof line["request_id"]).toBe("string");
    },
  );

  scenario("H-20", "invalid keys are never rate limited", async () => {
    const app = makeApp();
    for (let i = 0; i < 15; i++) {
      const res = await app.check("example.com", {
        headers: {
          authorization: "Bearer dh_wrongwrongwrongwrongwrongwrongwr",
        },
      });
      expect(res.status).toBe(401);
    }
    expect(app.logs).toEqual([]);
  });
});
