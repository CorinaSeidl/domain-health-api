import { createNodeResolver } from "../core/dns.js";
import { VERSION } from "../version.js";
import { configFromEnv } from "./config.js";
import { createHandler } from "./handler.js";
import { createStore } from "./store/index.js";

let handler: ((request: Request) => Promise<Response>) | undefined;

/**
 * Wires the framework-agnostic handler for Vercel Functions. This is the only place the
 * production DNS resolver is constructed (DNS-1). The store is Upstash Redis when its
 * credentials are set (D-1), otherwise in-memory: limits are then per instance and usage
 * counters are not durable.
 */
function getHandler(): (request: Request) => Promise<Response> {
  const log = (line: string) => console.log(line);
  handler ??= createHandler({
    resolver: createNodeResolver(),
    ...configFromEnv(process.env),
    store: createStore(process.env, log),
    log,
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
