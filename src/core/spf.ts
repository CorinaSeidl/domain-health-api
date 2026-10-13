import { isIPv4, isIPv6 } from "node:net";
import { DnsClient, normalizeName } from "./dns.js";
import { makeIssue } from "./issues.js";
import type { Issue, SpfResult } from "./types.js";

const MAX_LOOKUPS = 10; // SPF-16
const COUNTED = new Set(["include", "a", "mx", "ptr", "exists"]); // SPF-14

type Qualifier = "+" | "-" | "~" | "?";

interface Mechanism {
  name: "all" | "include" | "a" | "mx" | "ptr" | "ip4" | "ip6" | "exists";
  qualifier: Qualifier;
  /** domain-spec for include and exists, otherwise null */
  value: string | null;
}

interface ParsedSpf {
  mechanisms: Mechanism[];
  /** A single valid redirect target, or null (absent, empty, or duplicated). */
  redirect: string | null;
  /** Any redirect= term was present, even a malformed one. */
  hasRedirectTerm: boolean;
  /** One detail string per syntax problem (SPF-4..7). */
  errors: string[];
}

/** SPF-1: an SPF record is a TXT record that starts with v=spf1 followed by a space or the end. */
export function isSpfRecord(text: string): boolean {
  return /^v=spf1( |$)/i.test(text.trim());
}

function validCidr(text: string, max: number): boolean {
  if (!/^[0-9]{1,3}$/.test(text)) return false;
  return Number(text) <= max;
}

function validIp(value: string, version: 4 | 6): boolean {
  const slash = value.indexOf("/");
  const address = slash === -1 ? value : value.slice(0, slash);
  if (
    slash !== -1 &&
    !validCidr(value.slice(slash + 1), version === 4 ? 32 : 128)
  )
    return false;
  return version === 4
    ? isIPv4(address)
    : isIPv6(address) && !address.includes("%");
}

/** SPF-4..SPF-7. Terms with problems are reported and left out of evaluation. */
export function parseSpf(text: string): ParsedSpf {
  const terms = text.trim().split(/\s+/).slice(1);
  const parsed: ParsedSpf = {
    mechanisms: [],
    redirect: null,
    hasRedirectTerm: false,
    errors: [],
  };
  const redirects: string[] = [];
  let expCount = 0;

  for (const term of terms) {
    const modifier = /^([a-z][a-z0-9._-]*)=(.*)$/i.exec(term);
    if (modifier) {
      const name = (modifier[1] as string).toLowerCase();
      const value = modifier[2] as string;
      if (name === "redirect") {
        parsed.hasRedirectTerm = true;
        if (value === "")
          parsed.errors.push(`the redirect modifier "${term}" has no domain`);
        else redirects.push(value);
      } else if (name === "exp") {
        expCount += 1;
      }
      continue; // unknown modifiers are ignored without error
    }

    const m = /^([+\-~?])?([a-z][a-z0-9]*)(.*)$/i.exec(term);
    const name = m ? (m[2] as string).toLowerCase() : "";
    const qualifier = (m?.[1] ?? "+") as Qualifier;
    const rest = m ? (m[3] as string) : "";

    switch (name) {
      case "all":
        if (rest !== "") parsed.errors.push(`unrecognized term "${term}"`);
        else parsed.mechanisms.push({ name, qualifier, value: null });
        break;
      case "a":
      case "mx":
      case "ptr":
        if (rest !== "" && !rest.startsWith(":") && !rest.startsWith("/")) {
          parsed.errors.push(`unrecognized term "${term}"`);
        } else {
          parsed.mechanisms.push({ name, qualifier, value: null });
        }
        break;
      case "include":
      case "exists":
        if (!rest.startsWith(":") || rest.length < 2) {
          parsed.errors.push(`the ${name} mechanism "${term}" needs a domain`);
        } else {
          parsed.mechanisms.push({ name, qualifier, value: rest.slice(1) });
        }
        break;
      case "ip4":
      case "ip6": {
        const version = name === "ip4" ? 4 : 6;
        if (!rest.startsWith(":") || !validIp(rest.slice(1), version)) {
          parsed.errors.push(
            `"${term}" is not a valid ${name} address or range`,
          );
        } else {
          parsed.mechanisms.push({ name, qualifier, value: null });
        }
        break;
      }
      default:
        parsed.errors.push(`unrecognized term "${term}"`);
    }
  }

  if (redirects.length > 1)
    parsed.errors.push("more than one redirect modifier");
  if (expCount > 1) parsed.errors.push("more than one exp modifier");
  if (redirects.length === 1) parsed.redirect = redirects[0] as string;
  return parsed;
}

/** One evaluation context per request (SPF-14..SPF-22). */
class Evaluation {
  count = 0;
  exact = true;
  stopped = false;
  readonly issues: Issue[] = [];

  constructor(private readonly dns: DnsClient) {}

  /** Count one DNS-querying term. Returns false once the limit is passed (SPF-16). */
  private spend(): boolean {
    this.count += 1;
    if (this.count > MAX_LOOKUPS) {
      this.stopped = true;
      return false;
    }
    return true;
  }

  /**
   * Evaluate one record's terms. `path` holds the targets on the current include/redirect
   * path, including the root domain (SPF-18). Depth never needs its own check: a path deeper
   * than 10 has more than 10 counted terms, so SPF-22 is enforced by the count (SPF-16).
   */
  async evaluate(
    parsed: ParsedSpf,
    path: string[],
    redirectAllowed: boolean,
  ): Promise<void> {
    for (const mechanism of parsed.mechanisms) {
      if (this.stopped) return;
      if (!COUNTED.has(mechanism.name)) continue;
      if (!this.spend()) return;
      if (mechanism.name === "include") {
        await this.follow(mechanism.value as string, path);
      }
    }
    const hasAll = parsed.mechanisms.some((m) => m.name === "all");
    if (this.stopped || hasAll || !redirectAllowed || parsed.redirect === null)
      return;
    if (!this.spend()) return;
    await this.follow(parsed.redirect, path);
  }

  private async follow(rawTarget: string, path: string[]): Promise<void> {
    const target = normalizeName(rawTarget);

    if (target.includes("%{")) {
      // SPF-19: counted, but cannot be resolved without a message.
      this.exact = false;
      this.issues.push(makeIssue("SPF_MACRO_UNRESOLVED", { target }));
      return;
    }
    if (path.includes(target)) {
      this.issues.push(makeIssue("SPF_INCLUDE_LOOP", { target }));
      return;
    }

    const outcome = await this.dns.txt(target);
    if (outcome.kind === "error") {
      // SPF-20
      this.exact = false;
      this.issues.push(
        makeIssue(
          "DNS_LOOKUP_FAILED",
          { record: `the SPF record at ${target}` },
          "spf",
        ),
      );
      return;
    }
    const records =
      outcome.kind === "found" ? outcome.records.filter(isSpfRecord) : [];
    if (records.length !== 1) {
      // SPF-17
      this.issues.push(makeIssue("SPF_INCLUDE_NO_RECORD", { target }));
      return;
    }
    const parsed = parseSpf(records[0] as string);
    if (parsed.errors.length > 0) {
      // SPF-21
      this.issues.push(makeIssue("SPF_INCLUDE_INVALID", { target }));
      return;
    }
    await this.evaluate(parsed, [...path, target], true);
  }
}

function dedupe(issues: Issue[]): Issue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.code}\u0000${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function emptySpf(
  status: SpfResult["status"],
  issues: Issue[] = [],
): SpfResult {
  return {
    status,
    record: null,
    records: [],
    all_qualifier: null,
    lookup_count: null,
    lookup_count_exact: null,
    issues,
  };
}

/** SPEC.md §4. The apex TXT lookup is shared with the other checks through the DnsClient cache. */
export async function checkSpf(
  domain: string,
  dns: DnsClient,
): Promise<SpfResult> {
  const outcome = await dns.txt(domain);

  if (outcome.kind === "error") {
    // DNS-8
    return emptySpf("error", [
      makeIssue(
        "DNS_LOOKUP_FAILED",
        { record: `the SPF record for ${domain}` },
        "spf",
      ),
    ]);
  }

  const records =
    outcome.kind === "found" ? outcome.records.filter(isSpfRecord) : [];

  if (records.length === 0) {
    return emptySpf("missing", [makeIssue("SPF_MISSING", {})]);
  }
  if (records.length > 1) {
    return {
      ...emptySpf("invalid", [
        makeIssue("SPF_MULTIPLE_RECORDS", { count: records.length }),
      ]),
      records,
    };
  }

  const record = records[0] as string;
  const parsed = parseSpf(record);
  const issues: Issue[] = parsed.errors.map((detail) =>
    makeIssue("SPF_SYNTAX_ERROR", { detail }),
  );

  // SPF-8..SPF-13: findings on the top-level record only.
  const all = parsed.mechanisms.find((m) => m.name === "all");
  if (all) {
    if (all.qualifier === "+") issues.push(makeIssue("SPF_ALLOW_ALL", {}));
    else if (all.qualifier === "?")
      issues.push(makeIssue("SPF_NEUTRAL_ALL", {}));
  } else if (!parsed.hasRedirectTerm) {
    issues.push(makeIssue("SPF_NO_ALL", {}));
  }
  if (parsed.mechanisms.some((m) => m.name === "ptr")) {
    issues.push(makeIssue("SPF_PTR_USED", {}));
  }
  const redirectIgnored = all !== undefined && parsed.redirect !== null;
  if (redirectIgnored) issues.push(makeIssue("SPF_REDIRECT_IGNORED", {}));

  // SPF-14..SPF-22
  const evaluation = new Evaluation(dns);
  await evaluation.evaluate(parsed, [normalizeName(domain)], !redirectIgnored);
  issues.push(...evaluation.issues);
  if (evaluation.stopped) {
    evaluation.exact = false;
    issues.push(
      makeIssue("SPF_TOO_MANY_LOOKUPS", {
        count: evaluation.count,
        exact: false,
      }),
    );
  }

  const finalIssues = dedupe(issues);
  return {
    status: finalIssues.some((i) => i.severity === "error")
      ? "invalid"
      : "valid",
    record,
    records,
    all_qualifier: all ? all.qualifier : null,
    lookup_count: evaluation.count,
    lookup_count_exact: evaluation.exact,
    issues: finalIssues,
  };
}
