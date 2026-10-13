import { describe, expect, it } from "vitest";
import { hashKey, keyIdOf } from "../src/http/auth.js";
import { chargeSignupThrottle, clientIp } from "../src/http/keys.js";
import { MemoryStore } from "../src/http/store/memory.js";
import type { KeyRecord } from "../src/http/store/types.js";
import { K1, makeApp, START } from "./harness/http.js";

const HOUR = 60 * 60 * 1000;
const KEY_PATTERN = /^dh_[0-9A-Za-z]{32}$/;

interface Issued {
  api_key: string;
  key_id: string;
  limits: { per_minute: number; per_day: number };
  request_id: string;
}

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

/** A MemoryStore that records what the code asks of it. */
class SpyStore extends MemoryStore {
  increments: { key: string; expiresAtSec: number }[] = [];
  keyLookups: string[] = [];
  failIncrement = false;
  failGetKey = false;
  increment(key: string, expiresAtSec: number): Promise<number> {
    if (this.failIncrement) return Promise.reject(new Error("down"));
    this.increments.push({ key, expiresAtSec });
    return super.increment(key, expiresAtSec);
  }
  getKey(keyHash: string): Promise<KeyRecord | null> {
    this.keyLookups.push(keyHash);
    if (this.failGetKey) return Promise.reject(new Error("down"));
    return super.getKey(keyHash);
  }
}

describe("Self-serve keys (SPEC.md §11)", () => {
  it("KEY-1 POST /v1/keys returns 201 with the key, key_id and limits, without authentication", async () => {
    const app = makeApp();
    const res = await app.signup("dev@example.com");
    expect(res.status).toBe(201);
    const body = (await res.json()) as Issued;
    expect(body.api_key).toMatch(KEY_PATTERN); // AUTH-2
    expect(body.key_id).toBe(keyIdOf(hashKey(body.api_key))); // AUTH-4
    expect(body.limits).toEqual({ per_minute: 10, per_day: 200 });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-request-id")).toBe(body.request_id);
  });

  it("KEY-1 the issued limits follow the configured limits", async () => {
    const app = makeApp({ limits: { perMinute: 3, perDay: 7 } });
    const body = (await (await app.signup("dev@example.com")).json()) as Issued;
    expect(body.limits).toEqual({ per_minute: 3, per_day: 7 });
  });

  it("KEY-1 [AUTH-6] an issued key authenticates alongside API_KEY_HASHES keys", async () => {
    const app = makeApp();
    const { api_key } = (await (
      await app.signup("dev@example.com")
    ).json()) as Issued;
    const viaBearer = await app.check("example.com", { key: api_key });
    expect(viaBearer.status).toBe(200);
    const viaHeader = await app.check("example.com", {
      key: null,
      headers: { "x-api-key": api_key },
    });
    expect(viaHeader.status).toBe(200);
    expect((await app.check("example.com", { key: K1 })).status).toBe(200);
  });

  it("KEY-1 [AUTH-3] the plaintext key is never stored, and only the hash is", async () => {
    const app = makeApp();
    const { api_key } = (await (
      await app.signup("dev@example.com")
    ).json()) as Issued;
    const held = (app.store as MemoryStore).snapshot();
    expect(held).not.toContain(api_key);
    expect(held).toContain(hashKey(api_key));
    expect(app.logs.join("\n")).not.toContain(api_key);
  });

  it("KEY-1 [AUTH-6] each signup gets a different key", async () => {
    const app = makeApp();
    const a = (await (await app.signup("a@example.com")).json()) as Issued;
    const b = (await (await app.signup("b@example.com")).json()) as Issued;
    expect(a.api_key).not.toBe(b.api_key);
    expect(a.key_id).not.toBe(b.key_id);
  });

  it("KEY-1 [HTTP-1] methods other than POST are 405 with Allow: POST", async () => {
    const app = makeApp();
    for (const method of ["GET", "PUT", "DELETE"]) {
      const res = await app.request("/v1/keys", { method, key: null });
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
      expect(await errorCode(res)).toBe("method_not_allowed");
    }
  });

  it.each([
    ["empty", ""],
    ["blank", "   "],
    ["no @", "dev.example.com"],
    ["two @", "a@b@example.com"],
    ["no local part", "@example.com"],
    ["space in local part", "de v@example.com"],
    ["control character in local part", "de\u0001v@example.com"],
    ["single-label domain", "dev@localhost"],
    ["hyphen-led label", "dev@-example.com"],
    ["illegal character in domain", "dev@exa_mple.com"],
    ["numeric TLD", "dev@example.123"],
    ["too long", `${"a".repeat(250)}@example.com`],
    ["not a string", 42],
    ["null", null],
    ["object", { a: 1 }],
  ])("KEY-2 invalid email (%s) is 400 invalid_email", async (_name, email) => {
    const app = makeApp();
    const res = await app.signup(email);
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("invalid_email");
  });

  it("KEY-2 a missing body, bad JSON, a JSON array and an oversized body are 400 invalid_email", async () => {
    const app = makeApp();
    for (const body of [
      undefined,
      "not json",
      "[]",
      "null",
      JSON.stringify({ email: "a@example.com", pad: "x".repeat(5000) }),
    ]) {
      const res = await app.request("/v1/keys", {
        method: "POST",
        key: null,
        ...(body === undefined ? {} : { body }),
      });
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe("invalid_email");
    }
  });

  it("KEY-2 the 400 message says what is wrong", async () => {
    const res = await makeApp().signup("dev@localhost");
    const { error } = (await res.json()) as { error: { message: string } };
    expect(error.message).toMatch(/after the @/);
  });

  it("KEY-2 an address of 255 characters is rejected", async () => {
    const tooLong = `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(58)}.com`;
    expect(tooLong.length).toBe(255);
    expect((await makeApp().signup(tooLong)).status).toBe(400);
  });

  it("KEY-2 the email is trimmed and lowercased, and a 254-character address is accepted", async () => {
    const app = makeApp();
    const long = `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(57)}.com`;
    expect(long.length).toBe(254);
    expect((await app.signup(long)).status).toBe(201);
    expect((await app.signup("  Dev@Example.COM  ")).status).toBe(201);
    expect((await app.signup("dev@example.com")).status).toBe(409);
  });

  it("KEY-3 a repeat email is 409 key_exists and no second key is issued", async () => {
    const app = makeApp();
    const first = (await (
      await app.signup("dev@example.com")
    ).json()) as Issued;
    const again = await app.signup("DEV@example.com");
    expect(again.status).toBe(409);
    expect(await errorCode(again)).toBe("key_exists");
    const text = JSON.stringify(
      await (await app.signup("dev@example.com")).json(),
    );
    expect(text).not.toContain("api_key");
    expect(
      (await app.check("example.com", { key: first.api_key })).status,
    ).toBe(200);
    const held = (app.store as MemoryStore).snapshot();
    expect(held.match(/"keyHash"/g)).toHaveLength(1);
  });

  it("KEY-3 different emails each get a key", async () => {
    const app = makeApp();
    expect((await app.signup("a@example.com")).status).toBe(201);
    expect((await app.signup("b@example.com")).status).toBe(201);
  });

  it("KEY-4 the sixth signup in an hour from one IP is 429 with Retry-After", async () => {
    const app = makeApp();
    const headers = { "x-real-ip": "203.0.113.7" };
    for (let i = 0; i < 5; i++) {
      expect(
        (await app.signup(`dev${i}@example.com`, { headers })).status,
      ).toBe(201);
    }
    const res = await app.signup("dev5@example.com", { headers });
    expect(res.status).toBe(429);
    expect(await errorCode(res)).toBe("rate_limited");
    const retry = Number(res.headers.get("retry-after"));
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(3600);
  });

  it("KEY-4 the limit resets when the hour ends, and other IPs are unaffected", async () => {
    const app = makeApp();
    const headers = { "x-real-ip": "203.0.113.7" };
    for (let i = 0; i < 6; i++) {
      await app.signup(`dev${i}@example.com`, { headers });
    }
    const other = await app.signup("other@example.com", {
      headers: { "x-real-ip": "203.0.113.8" },
    });
    expect(other.status).toBe(201);
    app.advance(HOUR);
    expect((await app.signup("later@example.com", { headers })).status).toBe(
      201,
    );
  });

  it("KEY-4 the client IP comes from x-real-ip, else the first x-forwarded-for entry", () => {
    const h = (init: Record<string, string>) => new Headers(init);
    expect(
      clientIp(
        h({ "x-real-ip": "198.51.100.1", "x-forwarded-for": "10.0.0.1" }),
      ),
    ).toBe("198.51.100.1");
    expect(clientIp(h({ "x-forwarded-for": "10.0.0.1, 10.0.0.2" }))).toBe(
      "10.0.0.1",
    );
    expect(clientIp(h({ "x-forwarded-for": " 10.0.0.9 " }))).toBe("10.0.0.9");
    expect(clientIp(h({}))).toBeNull();
  });

  it("KEY-4 x-forwarded-for is used as the throttle key when x-real-ip is absent", async () => {
    const app = makeApp();
    const headers = { "x-forwarded-for": "198.51.100.5, 10.1.1.1" };
    for (let i = 0; i < 5; i++) {
      await app.signup(`dev${i}@example.com`, { headers });
    }
    expect((await app.signup("x@example.com", { headers })).status).toBe(429);
    // The same first entry behind a different proxy hop is the same client.
    const sameClient = { "x-forwarded-for": "198.51.100.5, 10.9.9.9" };
    expect(
      (await app.signup("y@example.com", { headers: sameClient })).status,
    ).toBe(429);
  });

  it("KEY-4 x-real-ip wins over x-forwarded-for, so a spoofed forwarded header does not reset the limit", async () => {
    const app = makeApp();
    for (let i = 0; i < 5; i++) {
      await app.signup(`dev${i}@example.com`, {
        headers: {
          "x-real-ip": "203.0.113.7",
          "x-forwarded-for": `1.1.1.${i}`,
        },
      });
    }
    const res = await app.signup("x@example.com", {
      headers: { "x-real-ip": "203.0.113.7", "x-forwarded-for": "9.9.9.9" },
    });
    expect(res.status).toBe(429);
  });

  it("KEY-4 invalid, repeated and accepted requests all count, so 409 cannot probe for emails", async () => {
    const app = makeApp();
    const headers = { "x-real-ip": "203.0.113.7" };
    await app.signup("dev@example.com", { headers }); // 201
    await app.signup("dev@example.com", { headers }); // 409
    await app.signup("not-an-email", { headers }); // 400
    await app.signup("dev@example.com", { headers }); // 409
    await app.signup("also bad", { headers }); // 400
    expect((await app.signup("dev@example.com", { headers })).status).toBe(429);
  });

  it("KEY-4 requests with no IP header share one throttle bucket", async () => {
    const app = makeApp();
    for (let i = 0; i < 5; i++) await app.signup(`dev${i}@example.com`);
    expect((await app.signup("x@example.com")).status).toBe(429);
  });

  it("KEY-4 [USE-2] the IP is hashed for the throttle and appears in no store entry and no log", async () => {
    const store = new SpyStore();
    const app = makeApp({ store });
    const ip = "203.0.113.77";
    await app.signup("dev@example.com", {
      headers: { "x-real-ip": ip, "x-forwarded-for": ip },
    });
    await app.signup("bad", { headers: { "x-real-ip": ip } });
    expect(store.snapshot()).not.toContain(ip);
    expect(JSON.stringify(store.increments)).not.toContain(ip);
    expect(app.logs.join("\n")).not.toContain(ip);
    expect(store.increments[0]?.key).toMatch(/^ks:[0-9a-f]{64}:\d+$/);
  });

  it("KEY-4 the throttle counter expires within 1 hour", async () => {
    const store = new SpyStore();
    const app = makeApp({ store });
    await app.signup("dev@example.com", {
      headers: { "x-real-ip": "203.0.113.7" },
    });
    const { expiresAtSec } = store.increments[0]!;
    const ttl = expiresAtSec - START / 1000;
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(3600);
  });

  it("KEY-4 [A-7] a throttle store outage fails open and logs store_unavailable", async () => {
    const store = new SpyStore();
    store.failIncrement = true;
    const decision = await chargeSignupThrottle(
      store,
      "203.0.113.7",
      new Date(START),
    );
    expect(decision).toEqual({
      allowed: true,
      retryAfterSec: null,
      storeUnavailable: true,
    });
    const app = makeApp({ store });
    expect((await app.signup("dev@example.com")).status).toBe(201);
    expect(app.parsedLogs().map((l) => l["event"])).toContain(
      "store_unavailable",
    );
  });

  it("KEY-5 the stored record has key_hash, key_id, email, created_at and status", async () => {
    const app = makeApp();
    const { api_key, key_id } = (await (
      await app.signup("Dev@Example.com")
    ).json()) as Issued;
    const record = await (app.store as MemoryStore).getKey(hashKey(api_key));
    expect(record).toEqual({
      keyHash: hashKey(api_key),
      keyId: key_id,
      email: "dev@example.com",
      createdAt: new Date(START).toISOString(),
      status: "active",
    });
  });

  it("KEY-5 the email is never logged, on success or failure", async () => {
    const app = makeApp();
    const email = "private.person@example.com";
    await app.signup(email); // 201
    await app.signup(email); // 409
    const { api_key } = (await (
      await app.signup("other@example.com")
    ).json()) as Issued;
    await app.check("example.com", { key: api_key });
    const out = app.logs.join("\n");
    expect(out).not.toBe("");
    expect(out).not.toContain("private.person");
    expect(out).not.toContain('example.com"');
  });

  it("KEY-5 [AUTH-5] a revoked key is 401 invalid_api_key", async () => {
    const store = new MemoryStore();
    const key = `dh_${"R".repeat(32)}`;
    await store.createKey({
      keyHash: hashKey(key),
      keyId: keyIdOf(hashKey(key)),
      email: "gone@example.com",
      createdAt: new Date(START).toISOString(),
      status: "revoked",
    });
    const app = makeApp({ store });
    const res = await app.check("example.com", { key });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
    expect(await errorCode(res)).toBe("invalid_api_key");
  });

  it("KEY-5 [AUTH-5] a well-formed key that is not stored is 401, and a malformed one never reaches the store", async () => {
    const store = new SpyStore();
    const app = makeApp({ store });
    const unknown = await app.check("example.com", {
      key: `dh_${"u".repeat(32)}`,
    });
    expect(unknown.status).toBe(401);
    expect(store.keyLookups).toHaveLength(1);
    const malformed = await app.check("example.com", { key: "dh_short" });
    expect(malformed.status).toBe(401);
    expect(store.keyLookups).toHaveLength(1);
  });

  it("KEY-5 [AUTH-6] a configured key does not depend on the store", async () => {
    const store = new SpyStore();
    store.failGetKey = true;
    const app = makeApp({ store });
    expect((await app.check("example.com", { key: K1 })).status).toBe(200);
    expect(store.keyLookups).toHaveLength(0);
  });

  it("KEY-5 [HTTP-8] a store failure while looking up a key is 500 internal_error with no detail", async () => {
    const store = new SpyStore();
    store.failGetKey = true;
    const app = makeApp({ store });
    const res = await app.check("example.com", { key: `dh_${"u".repeat(32)}` });
    expect(res.status).toBe(500);
    expect(await errorCode(res)).toBe("internal_error");
  });

  it("KEY-1 [HTTP-8] a store failure while issuing a key is 500 internal_error", async () => {
    const store = new SpyStore();
    store.createKey = () => Promise.reject(new Error("down"));
    const app = makeApp({ store });
    const res = await app.signup("dev@example.com");
    expect(res.status).toBe(500);
    expect(await errorCode(res)).toBe("internal_error");
  });
});
