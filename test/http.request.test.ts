import { readFileSync } from "node:fs";
import { describe, expect } from "vitest";
import { VERSION } from "../src/version.js";
import { schemaValidator } from "./harness/openapi.js";
import { HEX32, K1, makeApp, scenario } from "./harness/http.js";
import type { RawResolver } from "../src/core/dns.js";

const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("HTTP routing, envelope and headers (SPEC.md §8.1, §8.2)", () => {
  scenario(
    "H-01",
    "GET check returns 200 JSON that matches DomainCheckResult",
    async () => {
      const app = makeApp();
      const res = await app.check("example.com");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(
        "application/json; charset=utf-8",
      );
      const body = (await res.json()) as { domain: string; checked_at: string };
      // The harness already validated the body against openapi.yaml (Acceptance #3).
      expect(schemaValidator("DomainCheckResult")(body)).toBeNull();
      expect(body.domain).toBe("example.com");
      expect(body.checked_at).toMatch(/Z$/);
      expect(new Date(body.checked_at).toISOString()).toBe(body.checked_at);
    },
  );

  scenario("H-02", "a nonexistent domain is still 200", async () => {
    const app = makeApp({ zone: {} });
    const res = await app.check("nonexistent-domain.com");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      domain_exists: boolean;
      summary: { status: string };
    };
    expect(body.domain_exists).toBe(false);
    expect(body.summary.status).toBe("fail");
  });

  scenario(
    "H-03",
    "POST is 405 method_not_allowed with Allow: GET",
    async () => {
      const res = await makeApp().request(
        "/v1/domain/check?domain=example.com",
        {
          method: "POST",
        },
      );
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET");
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("method_not_allowed");
    },
  );

  scenario(
    "H-04",
    "HEAD returns the GET headers with an empty body",
    async () => {
      const app = makeApp();
      const path = "/v1/domain/check?domain=example.com";
      const get = await app.request(path);
      const head = await app.request(path, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
      const names = (r: Response) => [...r.headers.keys()].sort();
      expect(names(head)).toEqual(names(get));
      expect(head.headers.get("content-type")).toBe(
        get.headers.get("content-type"),
      );
      expect(head.headers.get("cache-control")).toBe("no-store");
    },
  );

  scenario(
    "H-05",
    "health is unauthenticated, makes no DNS lookups and reports the spec version",
    async () => {
      const app = makeApp();
      const res = await app.request("/v1/health", { key: null });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "ok", version: VERSION });
      expect(app.resolver.calls).toEqual([]);
      const pkg = JSON.parse(read("package.json")) as { version: string };
      const specVersion = /\*\*Version:\*\* (\S+)/.exec(
        read("spec/SPEC.md"),
      )?.[1];
      const openapiVersion = /^ {2}version: (\S+)/m.exec(
        read("spec/openapi.yaml"),
      )?.[1];
      expect(VERSION).toBe(pkg.version);
      expect(VERSION).toBe(specVersion);
      expect(VERSION).toBe(openapiVersion);
    },
  );

  scenario(
    "H-06",
    "an unknown path is a JSON 404 in the error envelope",
    async () => {
      const res = await makeApp().request("/v1/nope");
      expect(res.status).toBe(404);
      const body = (await res.json()) as {
        error: { code: string };
        request_id: string;
      };
      expect(schemaValidator("Error")(body)).toBeNull();
      expect(body.error.code).toBe("not_found");
      expect(body.request_id).toMatch(HEX32);
    },
  );

  scenario(
    "H-07",
    "X-Request-Id is 32 lowercase hex and equals body.request_id",
    async () => {
      const app = makeApp();
      for (const res of [
        await app.check("example.com"),
        await app.request("/v1/nope"),
        await app.request("/v1/health", { key: null }),
      ]) {
        const id = res.headers.get("x-request-id");
        expect(id).toMatch(HEX32);
        const body = (await res.json()) as { request_id?: string };
        if (body.request_id !== undefined) expect(body.request_id).toBe(id);
      }
    },
  );

  scenario("H-08", "a well-formed X-Request-Id is echoed", async () => {
    const res = await makeApp().check("example.com", {
      headers: { "x-request-id": "abc-123" },
    });
    expect(res.headers.get("x-request-id")).toBe("abc-123");
    expect(((await res.json()) as { request_id: string }).request_id).toBe(
      "abc-123",
    );
  });

  scenario(
    "H-09",
    "a malformed or oversized X-Request-Id is replaced",
    async () => {
      const app = makeApp();
      for (const bad of ["<script>", "a".repeat(65)]) {
        const res = await app.check("example.com", {
          headers: { "x-request-id": bad },
        });
        expect(res.headers.get("x-request-id")).toMatch(HEX32);
      }
      const ok = await app.check("example.com", {
        headers: { "x-request-id": "a".repeat(64) },
      });
      expect(ok.headers.get("x-request-id")).toBe("a".repeat(64));
    },
  );

  scenario("H-10", "every response is Cache-Control: no-store", async () => {
    const app = makeApp({ limits: { perMinute: 1, perDay: 200 } });
    const responses = [
      await app.check("example.com"), // 200
      await app.check("example.com"), // 429
      await app.check("not a domain", { key: null }), // 401
      await app.request("/v1/nope"), // 404
      await app.request("/v1/health", { key: null }),
    ];
    const other = makeApp();
    responses.push(await other.check("http://example.com")); // 400
    expect(responses.map((r) => r.status)).toEqual([
      200, 429, 401, 404, 200, 400,
    ]);
    for (const res of responses) {
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  scenario(
    "H-11",
    "a non-DNS exception from the resolver is a 500 that leaks nothing",
    async () => {
      const boom = () =>
        Promise.reject(
          new TypeError(
            "secret-internal-detail at /Users/dev/src/core/spf.ts:42",
          ),
        );
      const resolver: RawResolver = {
        resolveTxt: boom,
        resolveMx: boom,
        resolve4: boom,
        resolve6: boom,
      };
      const app = makeApp({ resolver });
      const res = await app.check("example.com");
      expect(res.status).toBe(500);
      const text = await res.text();
      const body = JSON.parse(text) as { error: { code: string } };
      expect(body.error.code).toBe("internal_error");
      for (const leak of [
        "TypeError",
        "secret-internal-detail",
        "/Users",
        ".ts",
        "    at ",
        K1,
      ]) {
        expect(text).not.toContain(leak);
        expect(app.logs.join("\n")).not.toContain(leak);
      }
    },
  );
});
