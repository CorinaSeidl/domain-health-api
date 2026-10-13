import type { RawResolver } from "../../src/core/dns.js";

/** Zone format from spec/vectors/README.md. */
export type ZoneRecords = {
  TXT?: string[][] | "ERROR";
  MX?: { priority: number; exchange: string }[] | "ERROR";
  A?: string[] | "ERROR";
  AAAA?: string[] | "ERROR";
};
export type Zone = Record<string, ZoneRecords>;

export interface FakeResolver extends RawResolver {
  /** Every query received, in call order, as "TYPE name". */
  readonly calls: string[];
}

function dnsError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/**
 * Builds a RawResolver from a vector's `dns` object (DNS-1).
 * - name not listed        -> ENOTFOUND  (nxdomain)
 * - type not listed        -> ENODATA    (no_records)
 * - type set to "ERROR"    -> ESERVFAIL  (error)
 * `shuffle` returns each record list in a different order, to prove outputs do not depend on it.
 */
export function fakeResolver(
  zone: Zone,
  options: { shuffle?: boolean } = {},
): FakeResolver {
  const names = new Map<string, ZoneRecords>(
    Object.entries(zone).map(([name, records]) => [
      name.toLowerCase(),
      records,
    ]),
  );
  const calls: string[] = [];

  function lookup<K extends keyof ZoneRecords, T>(
    type: K,
    name: string,
  ): Promise<T[]> {
    calls.push(`${type} ${name}`);
    const entry = names.get(name.toLowerCase());
    if (entry === undefined) return Promise.reject(dnsError("ENOTFOUND"));
    const value = entry[type];
    if (value === undefined) return Promise.reject(dnsError("ENODATA"));
    if (value === "ERROR") return Promise.reject(dnsError("ESERVFAIL"));
    const copy = [...(value as T[])];
    return Promise.resolve(options.shuffle ? copy.reverse() : copy);
  }

  return {
    calls,
    resolveTxt: (name) => lookup<"TXT", string[]>("TXT", name),
    resolveMx: (name) =>
      lookup<"MX", { priority: number; exchange: string }>("MX", name),
    resolve4: (name) => lookup<"A", string>("A", name),
    resolve6: (name) => lookup<"AAAA", string>("AAAA", name),
  };
}

/** `GENERATE:total_length_N` (normalize.json): a valid-looking name of exactly N characters. */
export function generateName(totalLength: number): string {
  const tld = "com";
  const labels: string[] = [];
  let remaining = totalLength - tld.length;
  while (remaining > 0) {
    // every label before the TLD costs its length plus one dot
    const take = Math.min(63, remaining - 1);
    labels.push("a".repeat(take));
    remaining -= take + 1;
  }
  return [...labels, tld].join(".");
}

/** `GENERATE:spf_wide_fanout_50_includes` (check.json). */
export function generateZone(name: string): Zone {
  if (name !== "spf_wide_fanout_50_includes")
    throw new Error(`Unknown generator: ${name}`);
  const includes = Array.from(
    { length: 50 },
    (_, i) => `include:s${i}.example.net`,
  );
  const zone: Zone = {
    "example.com": {
      TXT: [[`v=spf1 ${includes.join(" ")} -all`]],
      MX: [{ priority: 10, exchange: "mx.example.net" }],
    },
    "_dmarc.example.com": {
      TXT: [["v=DMARC1; p=reject; rua=mailto:d@example.com"]],
    },
    "mx.example.net": { A: ["192.0.2.25"] },
  };
  for (let i = 0; i < 50; i++) {
    zone[`s${i}.example.net`] = { TXT: [["v=spf1 ip4:192.0.2.0/24 -all"]] };
  }
  return zone;
}
