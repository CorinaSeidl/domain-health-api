import { randomInt } from "node:crypto";
import { pathToFileURL } from "node:url";
import { hashKey, keyIdOf } from "../src/http/auth.js";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** AUTH-2: `dh_` + 32 base62 characters from a CSPRNG (randomInt is unbiased). */
export function generateKey(): string {
  let body = "";
  for (let i = 0; i < 32; i++) body += BASE62[randomInt(BASE62.length)];
  return `dh_${body}`;
}

/** AUTH-6: the key appears once, followed by the hash to add to API_KEY_HASHES. */
export function issueKey(): { key: string; hash: string; keyId: string } {
  const key = generateKey();
  const hash = hashKey(key);
  return { key, hash, keyId: keyIdOf(hash) };
}

export function main(write: (line: string) => void = console.log): void {
  const { key, hash, keyId } = issueKey();
  write(`API key (shown once, give it to the developer now): ${key}`);
  write(`SHA-256 hash (add to API_KEY_HASHES, comma-separated): ${hash}`);
  write(`key_id (the only identifier that appears in logs): ${keyId}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
