import { DnsClient } from "./dns.js";
import { makeIssue } from "./issues.js";
import type { DmarcResult, Issue } from "./types.js";

const POLICIES = ["none", "quarantine", "reject"] as const;
const ALIGNMENTS = ["r", "s"] as const;
const KNOWN_TAGS = new Set([
  "p",
  "sp",
  "adkim",
  "aspf",
  "pct",
  "rua",
  "ruf",
  "fo",
  "rf",
]);

/** DM-1: begins with v=DMARC1 (tag name case-insensitive, value exact), then `;`, whitespace or end. */
export function isDmarcRecord(text: string): boolean {
  return /^[vV]=DMARC1(?=[;\s]|$)/.test(text.trim());
}

function emptyDmarc(
  status: DmarcResult["status"],
  issues: Issue[] = [],
): DmarcResult {
  return {
    status,
    record: null,
    records: [],
    policy: null,
    subdomain_policy: null,
    pct: null,
    adkim: null,
    aspf: null,
    rua: [],
    ruf: [],
    issues,
  };
}

export function notEvaluatedDmarc(): DmarcResult {
  return emptyDmarc("not_evaluated");
}

function oneOf<T extends string>(
  allowed: readonly T[],
  value: string,
): T | null {
  const lower = value.toLowerCase();
  return allowed.find((candidate) => candidate === lower) ?? null;
}

/** DM-10: split on commas; each URI must start with mailto: or https:. */
function parseUris(
  tag: "rua" | "ruf",
  value: string,
  issues: Issue[],
): string[] {
  const uris: string[] = [];
  for (const part of value.split(",").map((p) => p.trim())) {
    if (/^(mailto:|https:)/i.test(part)) {
      uris.push(part);
    } else {
      issues.push(
        makeIssue("DMARC_SYNTAX_ERROR", {
          tag,
          detail: `"${part}" must start with mailto: or https:`,
        }),
      );
    }
  }
  return uris;
}

/** SPEC.md §5. Looks up TXT at _dmarc.<domain>. */
export async function checkDmarc(
  domain: string,
  dns: DnsClient,
): Promise<DmarcResult> {
  const outcome = await dns.txt(`_dmarc.${domain}`);

  if (outcome.kind === "error") {
    // DNS-8
    return emptyDmarc("error", [
      makeIssue(
        "DNS_LOOKUP_FAILED",
        { record: `the DMARC record at _dmarc.${domain}` },
        "dmarc",
      ),
    ]);
  }

  const records =
    outcome.kind === "found" ? outcome.records.filter(isDmarcRecord) : [];

  // DM-2: nxdomain and no_records are both the normal "no DMARC" case.
  if (records.length === 0) {
    return emptyDmarc("missing", [makeIssue("DMARC_MISSING", {})]);
  }
  // DM-3
  if (records.length > 1) {
    return {
      ...emptyDmarc("invalid", [
        makeIssue("DMARC_MULTIPLE_RECORDS", { count: records.length }),
      ]),
      records,
    };
  }

  const record = records[0] as string;
  const issues: Issue[] = [];

  // DM-4: tag parsing. The first occurrence of a tag wins; a repeated known tag is an error.
  const tags = new Map<string, string>();
  for (const part of record.split(";")) {
    const segment = part.trim();
    if (segment === "") continue;
    const eq = segment.indexOf("=");
    const name = (eq === -1 ? segment : segment.slice(0, eq))
      .trim()
      .toLowerCase();
    const value = eq === -1 ? "" : segment.slice(eq + 1).trim();
    if (name === "v") continue;
    if (tags.has(name) && KNOWN_TAGS.has(name)) {
      issues.push(
        makeIssue("DMARC_SYNTAX_ERROR", {
          tag: name,
          detail: "the tag appears more than once",
        }),
      );
      continue;
    }
    if (!tags.has(name)) tags.set(name, value);
  }

  // DM-5
  let policy: DmarcResult["policy"] = null;
  const p = tags.get("p");
  if (p === undefined) {
    issues.push(
      makeIssue("DMARC_INVALID_POLICY", { detail: "the p tag is missing" }),
    );
  } else {
    policy = oneOf(POLICIES, p);
    if (policy === null) {
      issues.push(
        makeIssue("DMARC_INVALID_POLICY", {
          detail: `"${p}" is not a valid policy`,
        }),
      );
    }
  }

  // DM-6
  let subdomainPolicy: DmarcResult["subdomain_policy"] = null;
  const sp = tags.get("sp");
  if (sp !== undefined) {
    subdomainPolicy = oneOf(POLICIES, sp);
    if (subdomainPolicy === null) {
      issues.push(
        makeIssue("DMARC_SYNTAX_ERROR", {
          tag: "sp",
          detail: `"${sp}" must be none, quarantine or reject`,
        }),
      );
    }
  }

  const alignment = (tag: "adkim" | "aspf"): "r" | "s" | null => {
    const raw = tags.get(tag);
    if (raw === undefined) return "r";
    const value = oneOf(ALIGNMENTS, raw);
    if (value === null) {
      issues.push(
        makeIssue("DMARC_SYNTAX_ERROR", {
          tag,
          detail: `"${raw}" must be r or s`,
        }),
      );
    }
    return value;
  };
  const adkim = alignment("adkim");
  const aspf = alignment("aspf");

  let pct: number | null = 100;
  const pctRaw = tags.get("pct");
  if (pctRaw !== undefined) {
    if (/^[0-9]+$/.test(pctRaw) && Number(pctRaw) <= 100) {
      pct = Number(pctRaw);
    } else {
      pct = null;
      issues.push(
        makeIssue("DMARC_SYNTAX_ERROR", {
          tag: "pct",
          detail: `"${pctRaw}" must be a whole number from 0 to 100`,
        }),
      );
    }
  }

  const rua = tags.has("rua")
    ? parseUris("rua", tags.get("rua") as string, issues)
    : [];
  const ruf = tags.has("ruf")
    ? parseUris("ruf", tags.get("ruf") as string, issues)
    : [];

  // DM-7, DM-8, DM-9
  if (policy === "none") issues.push(makeIssue("DMARC_POLICY_NONE", {}));
  if (pct !== null && pct < 100)
    issues.push(makeIssue("DMARC_PARTIAL_PCT", { pct }));
  if (!tags.has("rua")) issues.push(makeIssue("DMARC_NO_RUA", {}));

  return {
    status: issues.some((i) => i.severity === "error") ? "invalid" : "valid",
    record,
    records,
    policy,
    subdomain_policy: subdomainPolicy,
    pct,
    adkim,
    aspf,
    rua,
    ruf,
    issues,
  };
}
