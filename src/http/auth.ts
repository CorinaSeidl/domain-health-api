import { createHash } from "node:crypto";
import type { Store } from "./store/types.js";

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** AUTH-4: the only key identifier allowed in logs and metrics. */
export function keyIdOf(keyHash: string): string {
  return keyHash.slice(0, 12);
}

/** AUTH-6: parses API_KEY_HASHES, comma-separated SHA-256 hex. Malformed entries are dropped. */
export function parseKeyHashes(value: string | undefined): Set<string> {
  const hashes = (value ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => /^[0-9a-f]{64}$/.test(h));
  return new Set(hashes);
}

/** AUTH-1: `Authorization: Bearer <key>`, else `X-API-Key`. Returns null when neither is usable. */
export function extractKey(headers: Headers): string | null {
  const bearer = /^bearer\s+(\S+)\s*$/i.exec(
    headers.get("authorization") ?? "",
  );
  if (bearer?.[1]) return bearer[1];
  const header = headers.get("x-api-key")?.trim();
  return header ? header : null;
}

/** AUTH-1: keys in the query string are rejected, never accepted. */
export function hasKeyInQuery(params: URLSearchParams): boolean {
  for (const name of params.keys()) {
    const lower = name.toLowerCase();
    if (lower === "api_key" || lower === "key") return true;
  }
  return false;
}

/**
 * AUTH-3: hash the presented key and look the hash up. The comparison runs on a hash of
 * attacker-supplied input, so its timing reveals nothing usable (BUILD_BRIEF "Key lookup").
 */
export function authenticate(
  presented: string,
  validHashes: ReadonlySet<string>,
): { keyId: string } | null {
  const hash = hashKey(presented);
  return validHashes.has(hash) ? { keyId: keyIdOf(hash) } : null;
}

/** AUTH-2: only this shape can be a key, so anything else never costs a store lookup. */
const KEY_FORMAT = /^dh_[0-9A-Za-z]{32}$/;

/**
 * AUTH-3, AUTH-6, KEY-5: a key is valid if its hash is in API_KEY_HASHES or belongs to an active
 * self-serve key in the store. Configured hashes are checked first, so they never depend on the
 * store. A store failure throws (the handler answers 500 internal_error), because treating an
 * unreachable store as "invalid key" would reject people who hold valid keys.
 */
export async function authenticateWithStore(
  presented: string,
  validHashes: ReadonlySet<string>,
  store: Store,
): Promise<{ keyId: string } | null> {
  const configured = authenticate(presented, validHashes);
  if (configured || !KEY_FORMAT.test(presented)) return configured;
  const hash = hashKey(presented);
  const record = await store.getKey(hash);
  return record?.status === "active" ? { keyId: keyIdOf(hash) } : null;
}
