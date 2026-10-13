import { logStoreUnconfigured, type LogSink } from "../usage.js";
import { MemoryStore } from "./memory.js";
import type { Store } from "./types.js";
import { UpstashStore, upstashConfigFromEnv } from "./upstash.js";

/**
 * Picks the durable Upstash store when credentials are set (D-1), else falls back to the
 * in-memory store and logs `store_unconfigured`. Call it once per process.
 */
export function createStore(
  env: Record<string, string | undefined>,
  log: LogSink,
  options: { now?: () => Date; fetch?: typeof fetch } = {},
): Store {
  const config = upstashConfigFromEnv(env);
  if (config) {
    return new UpstashStore(
      config,
      options.fetch,
      options.now ? () => options.now!().getTime() : undefined,
    );
  }
  logStoreUnconfigured(log, options.now?.() ?? new Date());
  return new MemoryStore();
}
