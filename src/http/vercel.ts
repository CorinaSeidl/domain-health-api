import { createNodeResolver } from "../core/dns.js";
import { VERSION } from "../version.js";
import { configFromEnv } from "./config.js";
import { createHandler } from "./handler.js";
import { MemoryStore } from "./store/memory.js";

let handler: ((request: Request) => Promise<Response>) | undefined;

/**
 * Wires the framework-agnostic handler for Vercel Functions. This is the only place the
 * production DNS resolver is constructed (DNS-1). The store is in-memory until D-1 is decided,
 * so rate limits are per instance and usage counters are not durable.
 */
function getHandler(): (request: Request) => Promise<Response> {
  handler ??= createHandler({
    resolver: createNodeResolver(),
    ...configFromEnv(process.env),
    store: new MemoryStore(),
    log: (line) => console.log(line),
    version: VERSION,
  });
  return handler;
}

/** Functions under /api are served at /api/v1/...; the public path is /v1/... (SPEC §8.1). */
export function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/")) {
    url.pathname = url.pathname.slice("/api".length);
    request = new Request(url, request);
  }
  return getHandler()(request);
}
