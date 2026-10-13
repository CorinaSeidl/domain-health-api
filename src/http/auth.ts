import { createHash } from "node:crypto";

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
