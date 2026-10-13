import type { Store } from "./store/types.js";

/** RL-1: config, not constants. */
export interface RateLimits {
  perMinute: number;
  perDay: number;
}

export const DEFAULT_LIMITS: RateLimits = { perMinute: 10, perDay: 200 };

export interface DailyWindow {
  limit: number;
  remaining: number;
  /** Unix seconds when the UTC day ends. */
  reset: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** RL-2: seconds until the window that was exceeded resets. Set when `allowed` is false. */
  retryAfterSec: number | null;
  /** RL-3: null when the store is unavailable (RL-4), so the headers are omitted. */
  daily: DailyWindow | null;
  storeUnavailable: boolean;
}

/** UTC day as YYYY-MM-DD. */
export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * RL-1..RL-4. Fixed windows: one per UTC minute and one per UTC day, each counted per key.
 * A request is charged to the minute window first. If that window is exceeded the request is
 * rejected without being charged to the day window. Store failures fail open (RL-4).
 */
export async function chargeRateLimit(
  store: Store,
  keyId: string,
  limits: RateLimits,
  now: Date,
): Promise<RateLimitDecision> {
  const nowSec = Math.floor(now.getTime() / 1000);
  const minute = Math.floor(nowSec / 60);
  const minuteReset = (minute + 1) * 60;
  const day = utcDay(now);
  const dayReset =
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) /
    1000;
  const dayKey = `rl:d:${keyId}:${day}`;
  const daily = (used: number): DailyWindow => ({
    limit: limits.perDay,
    remaining: Math.max(0, limits.perDay - used),
    reset: dayReset,
  });

  try {
    const inMinute = await store.increment(
      `rl:m:${keyId}:${minute}`,
      minuteReset,
    );
    if (inMinute > limits.perMinute) {
      return {
        allowed: false,
        retryAfterSec: minuteReset - nowSec,
        daily: daily(await store.get(dayKey)),
        storeUnavailable: false,
      };
    }
    const inDay = await store.increment(dayKey, dayReset);
    if (inDay > limits.perDay) {
      return {
        allowed: false,
        retryAfterSec: dayReset - nowSec,
        daily: daily(inDay),
        storeUnavailable: false,
      };
    }
    return {
      allowed: true,
      retryAfterSec: null,
      daily: daily(inDay),
      storeUnavailable: false,
    };
  } catch {
    return {
      allowed: true,
      retryAfterSec: null,
      daily: null,
      storeUnavailable: true,
    };
  }
}
