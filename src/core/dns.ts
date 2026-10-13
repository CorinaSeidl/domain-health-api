import { Resolver } from "node:dns/promises";

/** DNS-1: the only way any check touches DNS. Mirrors the relevant `node:dns/promises` calls. */
export interface RawResolver {
  resolveTxt(name: string): Promise<string[][]>;
  resolveMx(name: string): Promise<{ priority: number; exchange: string }[]>;
  resolve4(name: string): Promise<string[]>;
  resolve6(name: string): Promise<string[]>;
}

export type ErrorReason = "failure" | "query_cap" | "budget";

/** DNS-2: every lookup ends in exactly one of these outcomes. */
export type DnsOutcome<T> =
  | { kind: "found"; records: T }
  | { kind: "no_records" }
  | { kind: "nxdomain" }
  | { kind: "error"; reason: ErrorReason };

export interface MxEntry {
  priority: number;
  exchange: string;
}

export const DNS_QUERY_TIMEOUT_MS = 3000; // DNS-3
export const DNS_QUERY_RETRIES = 1; // DNS-3
export const DNS_BUDGET_MS = 8000; // DNS-3
export const DNS_MAX_QUERIES = 40; // DNS-4

/** Production resolver: public DNS via node:dns, with the DNS-3 timeout and retry. */
export function createNodeResolver(): RawResolver {
  const resolver = new Resolver({
    timeout: DNS_QUERY_TIMEOUT_MS,
    tries: DNS_QUERY_RETRIES + 1,
  });
  return {
    resolveTxt: (name) => resolver.resolveTxt(name),
    resolveMx: (name) => resolver.resolveMx(name),
    resolve4: (name) => resolver.resolve4(name),
    resolve6: (name) => resolver.resolve6(name),
  };
}

/**
 * DNS-2 classification of a rejected lookup. Only a rejection carrying a string `code` is a
 * DNS outcome. One without is a programming error, so it is rethrown and the HTTP layer
 * answers 500 (HTTP-8) instead of reporting a DNS failure.
 */
export function classifyError(err: unknown): DnsOutcome<never> {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code !== "string") throw err;
  if (code === "ENODATA") return { kind: "no_records" };
  if (code === "ENOTFOUND") return { kind: "nxdomain" };
  return { kind: "error", reason: "failure" };
}

export interface DnsClientOptions {
  maxQueries?: number;
  budgetMs?: number;
  now?: () => number;
}

function cacheKey(type: string, name: string): string {
  return `${type}:${name}`;
}

export function normalizeName(name: string): string {
  const lower = name.toLowerCase();
  return lower.endsWith(".") ? lower.slice(0, -1) : lower;
}

/**
 * Per-request wrapper around a RawResolver. Owns the pieces that are shared across all
 * checks in one request: the query cap (DNS-4), the time budget (DNS-3), outcome
 * classification (DNS-2), TXT joining (DNS-5), and a response cache. A cached response is
 * not a new query, so it does not count toward the cap (SPEC.md SPF-18).
 */
export class DnsClient {
  private readonly raw: RawResolver;
  private readonly maxQueries: number;
  private readonly now: () => number;
  private readonly deadline: number;
  private readonly cache = new Map<string, Promise<DnsOutcome<unknown>>>();
  private used = 0;

  constructor(raw: RawResolver, options: DnsClientOptions = {}) {
    this.raw = raw;
    this.maxQueries = options.maxQueries ?? DNS_MAX_QUERIES;
    this.now = options.now ?? Date.now;
    this.deadline = this.now() + (options.budgetMs ?? DNS_BUDGET_MS);
  }

  /** Number of queries actually issued to the resolver (cache hits and refusals excluded). */
  get queriesUsed(): number {
    return this.used;
  }

  /** TXT records, each already joined from its strings with no separator (DNS-5). */
  txt(name: string): Promise<DnsOutcome<string[]>> {
    return this.lookup("TXT", name, async (n) => {
      const records = await this.raw.resolveTxt(n);
      return records.map((strings) => strings.join(""));
    });
  }

  mx(name: string): Promise<DnsOutcome<MxEntry[]>> {
    return this.lookup("MX", name, async (n) => {
      const records = await this.raw.resolveMx(n);
      return records.map(({ priority, exchange }) => ({ priority, exchange }));
    });
  }

  a(name: string): Promise<DnsOutcome<string[]>> {
    return this.lookup("A", name, (n) => this.raw.resolve4(n));
  }

  aaaa(name: string): Promise<DnsOutcome<string[]>> {
    return this.lookup("AAAA", name, (n) => this.raw.resolve6(n));
  }

  private lookup<T extends unknown[]>(
    type: string,
    name: string,
    run: (name: string) => Promise<T>,
  ): Promise<DnsOutcome<T>> {
    const normalized = normalizeName(name);
    const key = cacheKey(type, normalized);
    const cached = this.cache.get(key);
    if (cached) return cached as Promise<DnsOutcome<T>>;

    if (this.used >= this.maxQueries) {
      return Promise.resolve({ kind: "error", reason: "query_cap" });
    }
    const remaining = this.deadline - this.now();
    if (remaining <= 0) {
      return Promise.resolve({ kind: "error", reason: "budget" });
    }

    this.used += 1;
    const pending = this.execute(run, normalized, remaining);
    this.cache.set(key, pending);
    return pending;
  }

  private async execute<T extends unknown[]>(
    run: (name: string) => Promise<T>,
    name: string,
    remainingMs: number,
  ): Promise<DnsOutcome<T>> {
    let timer: NodeJS.Timeout | undefined;
    const budget = new Promise<DnsOutcome<T>>((resolve) => {
      timer = setTimeout(
        () => resolve({ kind: "error", reason: "budget" }),
        remainingMs,
      );
    });
    const query = run(name).then(
      (records): DnsOutcome<T> =>
        records.length > 0
          ? { kind: "found", records }
          : { kind: "no_records" },
      (err): DnsOutcome<T> => classifyError(err),
    );
    try {
      return await Promise.race([query, budget]);
    } finally {
      clearTimeout(timer);
    }
  }
}
