import { isIP } from "node:net";
import { DnsClient } from "./dns.js";
import { makeIssue } from "./issues.js";
import type { Issue, MxRecord, MxResult } from "./types.js";

const MAX_RESOLVED = 5; // MX-6

export function notEvaluatedMx(): MxResult {
  return { status: "not_evaluated", records: [], issues: [] };
}

function isNullExchange(exchange: string): boolean {
  return exchange === "";
}

function isIpLiteral(exchange: string): boolean {
  return isIP(exchange.replace(/^\[|\]$/g, "")) !== 0;
}

/** MX-6: true if A or AAAA is found, false if both are absent, null if unchecked or a lookup failed. */
async function resolvesToAddress(
  exchange: string,
  dns: DnsClient,
): Promise<boolean | null> {
  const [a, aaaa] = await Promise.all([dns.a(exchange), dns.aaaa(exchange)]);
  if (a.kind === "found" || aaaa.kind === "found") return true;
  if (a.kind === "error" || aaaa.kind === "error") return null;
  return false;
}

/** SPEC.md §6. */
export async function checkMx(
  domain: string,
  dns: DnsClient,
): Promise<MxResult> {
  const outcome = await dns.mx(domain);

  if (outcome.kind === "error") {
    // DNS-8
    return {
      status: "error",
      records: [],
      issues: [
        makeIssue(
          "DNS_LOOKUP_FAILED",
          { record: `the MX records for ${domain}` },
          "mx",
        ),
      ],
    };
  }
  if (outcome.kind !== "found") {
    // MX-2
    return {
      status: "missing",
      records: [],
      issues: [makeIssue("MX_MISSING", {})],
    };
  }

  // MX-1, RES-7: strip one trailing dot, sort by priority then exchange.
  const records: MxRecord[] = outcome.records
    .map(({ priority, exchange }) => ({
      priority,
      exchange: exchange.endsWith(".") ? exchange.slice(0, -1) : exchange,
      resolves: null as boolean | null,
    }))
    .sort(
      (x, y) =>
        x.priority - y.priority ||
        (x.exchange < y.exchange ? -1 : x.exchange > y.exchange ? 1 : 0),
    );

  const hasNull = records.some((r) => isNullExchange(r.exchange));

  // MX-3
  if (hasNull && records.length === 1) {
    return { status: "null_mx", records, issues: [makeIssue("MX_NULL", {})] };
  }
  // MX-4
  if (hasNull) {
    return {
      status: "invalid",
      records,
      issues: [makeIssue("MX_NULL_MIXED", {})],
    };
  }

  const issues: Issue[] = [];
  let invalid = false;

  // MX-5
  for (const record of records) {
    if (isIpLiteral(record.exchange)) {
      issues.push(makeIssue("MX_TARGET_IS_IP", { exchange: record.exchange }));
      invalid = true;
    }
  }

  // MX-6: resolve the first five hostnames by priority.
  const toCheck = records
    .filter((r) => !isIpLiteral(r.exchange))
    .slice(0, MAX_RESOLVED);
  const results = await Promise.all(
    toCheck.map((r) => resolvesToAddress(r.exchange, dns)),
  );
  toCheck.forEach((record, i) => {
    record.resolves = results[i] as boolean | null;
  });

  // MX-7
  const unresolvable = toCheck.filter((r) => r.resolves === false);
  for (const record of unresolvable) {
    issues.push(
      makeIssue("MX_TARGET_UNRESOLVABLE", { exchange: record.exchange }),
    );
  }
  const checked = toCheck.filter((r) => r.resolves !== null);
  if (checked.length > 0 && unresolvable.length === checked.length)
    invalid = true;

  return { status: invalid ? "invalid" : "valid", records, issues };
}
