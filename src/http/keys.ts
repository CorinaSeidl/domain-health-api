import { createHash, randomInt } from "node:crypto";
import { domainSyntaxError } from "../core/normalize.js";
import { hashKey, keyIdOf } from "./auth.js";
import type { RateLimits } from "./ratelimit.js";
import type { KeyRecord, Store } from "./store/types.js";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** AUTH-2: `dh_` + 32 base62 characters from a CSPRNG (randomInt is unbiased). */
export function generateKey(): string {
  let body = "";
  for (let i = 0; i < 32; i++) body += BASE62[randomInt(BASE62.length)];
  return `dh_${body}`;
}

export function issueKey(): { key: string; hash: string; keyId: string } {
  const key = generateKey();
  const hash = hashKey(key);
  return { key, hash, keyId: keyIdOf(hash) };
}

const MAX_EMAIL_LENGTH = 254;

function hasWhitespaceOrControl(text: string): boolean {
  return (
    /\s/.test(text) ||
    [...text].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  );
}

export type EmailResult =
  { ok: true; email: string } | { ok: false; message: string };

/**
 * KEY-2 (for a given email): trimmed, lowercased, at most 254 characters, exactly one `@`, a non-empty local part
 * without whitespace, and a domain part that passes IN-6. No verification email in V0.
 */
export function validateEmail(input: unknown): EmailResult {
  if (typeof input !== "string" || input.trim() === "") {
    return {
      ok: false,
      message: 'Send your email address as {"email": "you@example.com"}.',
    };
  }
  const email = input.trim().toLowerCase();
  if (email.length > MAX_EMAIL_LENGTH) {
    return {
      ok: false,
      message: "That email address is longer than 254 characters.",
    };
  }
  const parts = email.split("@");
  if (parts.length !== 2) {
    return {
      ok: false,
      message: "An email address has exactly one @, like you@example.com.",
    };
  }
  const [local, domain] = parts as [string, string];
  if (local === "" || hasWhitespaceOrControl(local)) {
    return {
      ok: false,
      message: "The part of the email before the @ is missing or has spaces.",
    };
  }
  if (domainSyntaxError(domain) !== null) {
    return {
      ok: false,
      message: "The part of the email after the @ is not a valid domain name.",
    };
  }
  return { ok: true, email };
}

export type KeyRequestResult =
  { ok: true; email: string | null } | { ok: false; message: string };

const BODY_SHAPE_MESSAGE =
  'Send an empty body, or JSON like {"email": "you@example.com"}. Email is optional.';

/**
 * KEY-1, KEY-2: the request body is empty, `{}`, or `{"email": ...}`. A missing body, a missing
 * `email`, `null` or a blank string means no email. Anything else that is not a JSON object, or an
 * `email` that is not a string, is rejected.
 */
export function parseKeyRequest(text: string): KeyRequestResult {
  if (text.trim() === "") return { ok: true, email: null };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, message: BODY_SHAPE_MESSAGE };
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, message: BODY_SHAPE_MESSAGE };
  }
  const email = (body as { email?: unknown }).email;
  if (email === undefined || email === null) return { ok: true, email: null };
  if (typeof email !== "string")
    return { ok: false, message: BODY_SHAPE_MESSAGE };
  if (email.trim() === "") return { ok: true, email: null };
  const checked = validateEmail(email);
  return checked.ok ? { ok: true, email: checked.email } : checked;
}

/** KEY-4: `x-real-ip`, else the first entry of `x-forwarded-for`. Null when neither is usable. */
export function clientIp(headers: Headers): string | null {
  const real = headers.get("x-real-ip")?.trim();
  if (real) return real;
  const first = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return first ? first : null;
}

/** KEY-4: free-tier signup throttle. Config, not a constant in the handler. */
export const SIGNUP_LIMIT_PER_HOUR = 5;
const HOUR_SEC = 3600;

export interface SignupDecision {
  allowed: boolean;
  /** Seconds until the throttle window ends. Set when `allowed` is false. */
  retryAfterSec: number | null;
  storeUnavailable: boolean;
}

/**
 * KEY-4. One counter per hashed IP per UTC hour, expiring when that hour ends (so the TTL is at
 * most 1 hour). The IP itself is never stored, logged or returned: only its SHA-256 reaches the
 * store. With no IP, requests share one bucket. A store failure fails open (A-7).
 */
export async function chargeSignupThrottle(
  store: Store,
  ip: string | null,
  now: Date,
  limit: number = SIGNUP_LIMIT_PER_HOUR,
): Promise<SignupDecision> {
  const nowSec = Math.floor(now.getTime() / 1000);
  const hour = Math.floor(nowSec / HOUR_SEC);
  const reset = (hour + 1) * HOUR_SEC;
  const id = createHash("sha256")
    .update(`signup:${ip ?? "unknown"}`)
    .digest("hex");
  try {
    const count = await store.increment(`ks:${id}:${hour}`, reset);
    return count > limit
      ? {
          allowed: false,
          retryAfterSec: reset - nowSec,
          storeUnavailable: false,
        }
      : { allowed: true, retryAfterSec: null, storeUnavailable: false };
  } catch {
    return { allowed: true, retryAfterSec: null, storeUnavailable: true };
  }
}

export interface CreatedKey {
  apiKey: string;
  keyId: string;
  record: KeyRecord;
}

/**
 * KEY-1, KEY-3, KEY-5: issues a new key and stores its hash, with the optional email. There is no
 * per-email limit. The plaintext key exists only in the return value.
 */
export async function createSelfServeKey(
  store: Store,
  email: string | null,
  now: Date,
): Promise<CreatedKey> {
  const { key, hash, keyId } = issueKey();
  const record: KeyRecord = {
    keyHash: hash,
    keyId,
    email,
    createdAt: now.toISOString(),
    status: "active",
  };
  await store.createKey(record);
  return { apiKey: key, keyId, record };
}

export function keyIssuedBody(
  created: CreatedKey,
  limits: RateLimits,
  requestId: string,
) {
  return {
    api_key: created.apiKey,
    key_id: created.keyId,
    limits: { per_minute: limits.perMinute, per_day: limits.perDay },
    request_id: requestId,
  };
}
