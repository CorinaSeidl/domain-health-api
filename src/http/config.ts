import { parseKeyHashes } from "./auth.js";
import { safeContactUrl } from "./landing.js";
import { DEFAULT_LIMITS, type RateLimits } from "./ratelimit.js";

function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Reads the environment: API_KEY_HASHES (AUTH-6), the RL-1 limits (config) and CONTACT_URL (LP-3). */
export function configFromEnv(env: Record<string, string | undefined>): {
  keyHashes: Set<string>;
  limits: RateLimits;
  contactUrl: string | null;
} {
  return {
    keyHashes: parseKeyHashes(env["API_KEY_HASHES"]),
    contactUrl: safeContactUrl(env["CONTACT_URL"]),
    limits: {
      perMinute: positiveInt(
        env["RATE_LIMIT_PER_MINUTE"],
        DEFAULT_LIMITS.perMinute,
      ),
      perDay: positiveInt(env["RATE_LIMIT_PER_DAY"], DEFAULT_LIMITS.perDay),
    },
  };
}
