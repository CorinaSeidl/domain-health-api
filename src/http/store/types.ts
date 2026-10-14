/**
 * Storage behind rate limiting (RL-*) and usage tracking (USE-3). The durable implementation
 * is Upstash Redis (DECISIONS.md D-1); the in-memory one serves tests and local dev. Implementations may throw
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
  /** KEY-3, KEY-5: stores a self-serve key. There is no per-email limit. */
  createKey(record: KeyRecord): Promise<void>;
  /** AUTH-3: the stored key whose SHA-256 is `keyHash`, or null. */
  getKey(keyHash: string): Promise<KeyRecord | null>;
}

/** KEY-5. The email is optional (null when none was given), for contact only, and never logged. */
export interface KeyRecord {
  keyHash: string;
  keyId: string;
  email: string | null;
  /** ISO-8601 UTC. */
  createdAt: string;
  status: "active" | "revoked";
}

export interface KeyUsage {
  keyId: string;
  counts: Record<string, number>;
}
