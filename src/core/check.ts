import { randomBytes } from "node:crypto";
import { DnsClient, type DnsClientOptions, type RawResolver } from "./dns.js";
import { checkDmarc, notEvaluatedDmarc } from "./dmarc.js";
import { LIMITATIONS, makeIssue } from "./issues.js";
import { checkMx, notEvaluatedMx } from "./mx.js";
import { checkSpf, emptySpf } from "./spf.js";
import type { DomainCheckResult, Issue } from "./types.js";

export interface CheckOptions {
  /** Used for `checked_at`. Defaults to the current time. */
  now?: () => Date;
  /** Used for `request_id`. Defaults to 16 random bytes as hex (HTTP-6). */
  requestId?: string;
  dns?: DnsClientOptions;
}

export interface CheckOutcome {
  result: DomainCheckResult;
  /** DNS queries actually issued, for usage logging (USE-1). */
  dnsQueries: number;
}

function summarize(
  issues: Issue[],
  anyCheckErrored: boolean,
): DomainCheckResult["summary"] {
  const count = (severity: Issue["severity"]) =>
    issues.filter((i) => i.severity === severity).length;
  const errors = count("error");
  const warnings = count("warning");
  const info = count("info");
  const status =
    errors > 0
      ? "fail"
      : anyCheckErrored
        ? "incomplete"
        : warnings > 0
          ? "warn"
          : "pass";
  return { status, errors, warnings, info };
}

/**
 * SPEC.md §7. `domain` must already be normalized (see normalizeDomain). DNS-6: the three
 * top-level lookups start together; the checks share one DnsClient so the query cap and time
 * budget are per request (DNS-3, DNS-4).
 */
export async function checkDomain(
  domain: string,
  resolver: RawResolver,
  options: CheckOptions = {},
): Promise<CheckOutcome> {
  const dns = new DnsClient(resolver, options.dns);

  const [spf, dmarc, mx] = await Promise.all([
    checkSpf(domain, dns),
    checkDmarc(domain, dns),
    checkMx(domain, dns),
  ]);

  // DNS-7: both apex lookups are cached, so these awaits issue no new queries.
  const [apexTxt, apexMx] = await Promise.all([
    dns.txt(domain),
    dns.mx(domain),
  ]);
  const domainExists = !(
    apexTxt.kind === "nxdomain" && apexMx.kind === "nxdomain"
  );

  const domainIssues = domainExists
    ? []
    : [makeIssue("DOMAIN_NOT_FOUND", { domain })];
  const checks = domainExists
    ? { spf, dmarc, mx }
    : {
        spf: emptySpf("not_evaluated"),
        dmarc: notEvaluatedDmarc(),
        mx: notEvaluatedMx(),
      };

  // RES-2
  const issues = [
    ...domainIssues,
    ...checks.spf.issues,
    ...checks.dmarc.issues,
    ...checks.mx.issues,
  ];
  const anyCheckErrored = [
    checks.spf.status,
    checks.dmarc.status,
    checks.mx.status,
  ].includes("error");

  const result: DomainCheckResult = {
    request_id: options.requestId ?? randomBytes(16).toString("hex"),
    domain,
    domain_exists: domainExists,
    checked_at: (options.now?.() ?? new Date()).toISOString(),
    summary: summarize(issues, anyCheckErrored),
    spf: checks.spf,
    dmarc: checks.dmarc,
    mx: checks.mx,
    issues,
    limitations: [...LIMITATIONS],
  };
  return { result, dnsQueries: dns.queriesUsed };
}
