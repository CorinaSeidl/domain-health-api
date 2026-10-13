import {
  emailIndex,
  type KeyRecord,
  type KeyUsage,
  type Store,
} from "./types.js";

/** Upstash Redis REST credentials (DECISIONS.md D-1). */
export interface UpstashConfig {
  url: string;
  token: string;
}

/**
 * Reads UPSTASH_REDIS_REST_URL/TOKEN, else KV_REST_API_URL/TOKEN (the names the Vercel
 * Marketplace integration injects). A pair counts only when both halves are set.
 */
export function upstashConfigFromEnv(
  env: Record<string, string | undefined>,
): UpstashConfig | null {
  for (const [urlName, tokenName] of [
    ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"],
    ["KV_REST_API_URL", "KV_REST_API_TOKEN"],
  ] as const) {
    const url = env[urlName]?.trim();
    const token = env[tokenName]?.trim();
    if (url && token) return { url: url.replace(/\/+$/, ""), token };
  }
  return null;
}

/** USE-3: usage counters outlive the 7-day launch window by a wide margin (at least 90 days). */
export const USAGE_RETENTION_DAYS = 100;
const DAY_SEC = 86_400;
const REQUEST_TIMEOUT_MS = 2000;
const PIPELINE_CHUNK = 500;

type Command = (string | number)[];
type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

function dayStartSec(day: string): number {
  return Date.parse(`${day}T00:00:00Z`) / 1000;
}

function utcDayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Store over the Upstash REST API with plain fetch (no SDK). Any failure throws, and callers
 * fail open (RL-4, USE-5). Errors never include the token or the response body.
 *
 * Keys: counters are whatever the caller passes (rate limits); usage is `usage:c:<key_id>:<day>`
 * (successful checks that day) plus `usage:d:<day>` (the key_ids active that day). Both expire
 * USAGE_RETENTION_DAYS after their day ends, and a day with a count is an active day.
 * Self-serve keys (KEY-5) are `key:h:<key_hash>` (the JSON record, no expiry) and
 * `key:e:<sha256(email)>` (the key_hash, written with NX so one email gets one key).
 */
export class UpstashStore implements Store {
  constructor(
    private readonly config: UpstashConfig,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
    private readonly now: () => number = Date.now,
  ) {}

  private async send(
    path: "/pipeline" | "/multi-exec",
    commands: Command[],
  ): Promise<unknown[]> {
    const res = await this.fetchImpl(`${this.config.url}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(commands),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok)
      throw new Error(`Upstash request failed with HTTP ${res.status}`);
    const body: unknown = await res.json();
    if (!Array.isArray(body) || body.length !== commands.length) {
      throw new Error("Upstash returned an unexpected response");
    }
    return body.map((item: { result?: unknown; error?: unknown }) => {
      if (
        item === null ||
        typeof item !== "object" ||
        item.error !== undefined
      ) {
        throw new Error("Upstash command failed");
      }
      return item.result;
    });
  }

  /** INCR and EXPIREAT in one MULTI/EXEC request, so the counter always gets its expiry. */
  async increment(key: string, expiresAtSec: number): Promise<number> {
    const [value] = await this.send("/multi-exec", [
      ["INCR", key],
      ["EXPIREAT", key, expiresAtSec],
    ]);
    const n = Number(value);
    if (!Number.isInteger(n))
      throw new Error("Upstash returned a non-integer count");
    return n;
  }

  async get(key: string): Promise<number> {
    const [value] = await this.send("/pipeline", [["GET", key]]);
    return value === null || value === undefined ? 0 : Number(value);
  }

  async recordSuccess(keyId: string, day: string): Promise<void> {
    const expiresAt = dayStartSec(day) + (USAGE_RETENTION_DAYS + 1) * DAY_SEC;
    const counter = `usage:c:${keyId}:${day}`;
    const active = `usage:d:${day}`;
    await this.send("/multi-exec", [
      ["INCR", counter],
      ["EXPIREAT", counter, expiresAt],
      ["SADD", active, keyId],
      ["EXPIREAT", active, expiresAt],
    ]);
  }

  async listUsage(): Promise<KeyUsage[]> {
    const today = this.now();
    const days: string[] = [];
    for (let i = USAGE_RETENTION_DAYS; i >= 0; i--) {
      days.push(utcDayOf(today - i * DAY_SEC * 1000));
    }
    const members = await this.send(
      "/pipeline",
      days.map((day) => ["SMEMBERS", `usage:d:${day}`]),
    );
    const pairs: { keyId: string; day: string }[] = [];
    days.forEach((day, i) => {
      for (const keyId of (members[i] as string[] | null) ?? []) {
        pairs.push({ keyId, day });
      }
    });
    const byKey = new Map<string, Record<string, number>>();
    for (let start = 0; start < pairs.length; start += PIPELINE_CHUNK) {
      const chunk = pairs.slice(start, start + PIPELINE_CHUNK);
      const counts = await this.send(
        "/pipeline",
        chunk.map((p) => ["GET", `usage:c:${p.keyId}:${p.day}`]),
      );
      chunk.forEach((p, i) => {
        const n = Number(counts[i]);
        if (!Number.isInteger(n) || n <= 0) return; // expired or racing: not an active day
        const record = byKey.get(p.keyId) ?? {};
        record[p.day] = n;
        byKey.set(p.keyId, record);
      });
    }
    return [...byKey]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([keyId, counts]) => ({ keyId, counts }));
  }

  async createKey(record: KeyRecord): Promise<boolean> {
    const recordKey = `key:h:${record.keyHash}`;
    // The record goes first: a crash before the email index leaves an unreachable record, never
    // an email that is locked out of getting a key.
    const [, claimed] = await this.send("/pipeline", [
      ["SET", recordKey, JSON.stringify(record)],
      ["SET", `key:e:${emailIndex(record.email)}`, record.keyHash, "NX"],
    ]);
    if (claimed === "OK") return true;
    await this.send("/pipeline", [["DEL", recordKey]]);
    return false;
  }

  async getKey(keyHash: string): Promise<KeyRecord | null> {
    const [value] = await this.send("/pipeline", [["GET", `key:h:${keyHash}`]]);
    if (typeof value !== "string") return null;
    const parsed = JSON.parse(value) as Partial<KeyRecord>;
    if (
      parsed.keyHash !== keyHash ||
      typeof parsed.keyId !== "string" ||
      typeof parsed.email !== "string" ||
      typeof parsed.createdAt !== "string" ||
      (parsed.status !== "active" && parsed.status !== "revoked")
    ) {
      throw new Error("Upstash returned an unexpected key record");
    }
    return parsed as KeyRecord;
  }
}
