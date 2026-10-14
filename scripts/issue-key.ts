import { pathToFileURL } from "node:url";
import { generateKey, issueKey } from "../src/http/keys.js";

/** AUTH-2 and AUTH-6: the key generator lives in src/http/keys.ts; re-exported for the scripts. */
export { generateKey, issueKey };

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
