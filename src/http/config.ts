import { parseKeyHashes } from "./auth.js";
import { DEFAULT_LIMITS, type RateLimits } from "./ratelimit.js";

function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Reads the environment: API_KEY_HASHES (AUTH-6) and the RL-1 limits (config). */
export function configFromEnv(env: Record<string, string | undefined>): {
  keyHashes: Set<string>;
  limits: RateLimits;
} {
  return {
    keyHashes: parseKeyHashes(env["API_KEY_HASHES"]),
    limits: {
      perMinute: positiveInt(
        env["RATE_LIMIT_PER_MINUTE"],
        DEFAULT_LIMITS.perMinute,
      ),
      perDay: positiveInt(env["RATE_LIMIT_PER_DAY"], DEFAULT_LIMITS.perDay),
    },
  };
}
