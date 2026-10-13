/**
 * Storage behind rate limiting (RL-*) and usage tracking (USE-3). The durable implementation
 * is pending DECISIONS.md D-1; only the in-memory one exists in M2. Implementations may throw
 * or reject: callers fail open (RL-4, USE-5).
 */
export interface Store {
  /** Adds 1 to a counter that expires at `expiresAtSec` (Unix seconds); returns the new value. */
  increment(key: string, expiresAtSec: number): Promise<number>;
  /** Current counter value without changing it; 0 when absent or expired. */
  get(key: string): Promise<number>;
  /** USE-3: counts one successful (200) check for `keyId` on UTC day `day` (YYYY-MM-DD). */
  recordSuccess(keyId: string, day: string): Promise<void>;
  /** USE-3: per key, successful checks per UTC day. A day with a count is an active day. */
  listUsage(): Promise<KeyUsage[]>;
}

export interface KeyUsage {
  keyId: string;
  counts: Record<string, number>;
}
