import {
  emailIndex,
  type KeyRecord,
  type KeyUsage,
  type Store,
} from "./types.js";

/** In-memory Store for tests and local dev (RL-4). State is per process and lost on restart. */
export class MemoryStore implements Store {
  private readonly counters = new Map<
    string,
    { value: number; expiresAtSec: number }
  >();
  private readonly usage = new Map<string, Map<string, number>>();
  private readonly keys = new Map<string, KeyRecord>();
  private readonly emails = new Set<string>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  private live(key: string): { value: number; expiresAtSec: number } | null {
    const entry = this.counters.get(key);
    if (!entry) return null;
    if (entry.expiresAtSec <= this.now() / 1000) {
      this.counters.delete(key);
      return null;
    }
    return entry;
  }

  increment(key: string, expiresAtSec: number): Promise<number> {
    const entry = this.live(key);
    if (entry) {
      entry.value += 1;
      return Promise.resolve(entry.value);
    }
    this.counters.set(key, { value: 1, expiresAtSec });
    return Promise.resolve(1);
  }

  get(key: string): Promise<number> {
    return Promise.resolve(this.live(key)?.value ?? 0);
  }

  recordSuccess(keyId: string, day: string): Promise<void> {
    const days = this.usage.get(keyId) ?? new Map<string, number>();
    days.set(day, (days.get(day) ?? 0) + 1);
    this.usage.set(keyId, days);
    return Promise.resolve();
  }

  listUsage(): Promise<KeyUsage[]> {
    return Promise.resolve(
      [...this.usage].map(([keyId, days]) => ({
        keyId,
        counts: Object.fromEntries(days),
      })),
    );
  }

  createKey(record: KeyRecord): Promise<boolean> {
    const index = emailIndex(record.email);
    if (this.emails.has(index)) return Promise.resolve(false);
    this.emails.add(index);
    this.keys.set(record.keyHash, { ...record });
    return Promise.resolve(true);
  }

  getKey(keyHash: string): Promise<KeyRecord | null> {
    const record = this.keys.get(keyHash);
    return Promise.resolve(record ? { ...record } : null);
  }

  /** Everything held, for tests that assert no plaintext key is stored (AUTH-3). */
  snapshot(): string {
    return JSON.stringify({
      counters: [...this.counters],
      usage: [...this.usage].map(([k, d]) => [k, [...d]]),
      keys: [...this.keys],
    });
  }
}
