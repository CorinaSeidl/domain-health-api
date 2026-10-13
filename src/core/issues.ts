import type { CheckName, Issue, Severity } from "./types.js";

/** Parameters each issue message template needs. Closed list: SPEC.md §9. */
export interface IssueParams {
  DOMAIN_NOT_FOUND: { domain: string };
  DNS_LOOKUP_FAILED: { record: string };
  SPF_MISSING: Record<string, never>;
  SPF_MULTIPLE_RECORDS: { count: number };
  SPF_SYNTAX_ERROR: { detail: string };
  SPF_ALLOW_ALL: Record<string, never>;
  SPF_NEUTRAL_ALL: Record<string, never>;
  SPF_NO_ALL: Record<string, never>;
  SPF_PTR_USED: Record<string, never>;
  SPF_REDIRECT_IGNORED: Record<string, never>;
  SPF_TOO_MANY_LOOKUPS: { count: number; exact: boolean };
  SPF_INCLUDE_NO_RECORD: { target: string };
  SPF_INCLUDE_LOOP: { target: string };
  SPF_MACRO_UNRESOLVED: { target: string };
  SPF_INCLUDE_INVALID: { target: string };
  DMARC_MISSING: Record<string, never>;
  DMARC_MULTIPLE_RECORDS: { count: number };
  DMARC_SYNTAX_ERROR: { tag: string; detail: string };
  DMARC_INVALID_POLICY: { detail: string };
  DMARC_POLICY_NONE: Record<string, never>;
  DMARC_PARTIAL_PCT: { pct: number };
  DMARC_NO_RUA: Record<string, never>;
  MX_MISSING: Record<string, never>;
  MX_NULL: Record<string, never>;
  MX_NULL_MIXED: Record<string, never>;
  MX_TARGET_IS_IP: { exchange: string };
  MX_TARGET_UNRESOLVABLE: { exchange: string };
}

export type IssueCode = keyof IssueParams;

interface IssueDef<C extends IssueCode> {
  check: CheckName;
  severity: Severity;
  message: (p: IssueParams[C]) => string;
}

type Registry = { [C in IssueCode]: IssueDef<C> };

/**
 * Messages describe what was found in DNS and why it matters (SCOPE-2): they never say a
 * domain will deliver, is safe, or is compliant. Plain sentences, no markdown (RES-3).
 */
export const ISSUE_REGISTRY: Registry = {
  DOMAIN_NOT_FOUND: {
    check: "domain",
    severity: "error",
    message: ({ domain }) =>
      `The domain ${domain} does not exist in DNS, so the SPF, DMARC and MX checks were not evaluated.`,
  },
  DNS_LOOKUP_FAILED: {
    check: "spf", // overridden per use; the check is chosen by the caller
    severity: "warning",
    message: ({ record }) =>
      `The DNS lookup for ${record} failed or timed out, so this result is incomplete. Try again later.`,
  },
  SPF_MISSING: {
    check: "spf",
    severity: "warning",
    message: () =>
      "No SPF record was found at the domain apex, so receiving servers cannot tell which servers may send mail for this domain.",
  },
  SPF_MULTIPLE_RECORDS: {
    check: "spf",
    severity: "error",
    message: ({ count }) =>
      `${count} SPF records were found at the domain apex. A domain must publish exactly one, and receivers treat several as a permanent error.`,
  },
  SPF_SYNTAX_ERROR: {
    check: "spf",
    severity: "error",
    message: ({ detail }) => `The SPF record has a syntax problem: ${detail}.`,
  },
  SPF_ALLOW_ALL: {
    check: "spf",
    severity: "error",
    message: () =>
      "The SPF record ends with +all (or a bare all), which authorizes any server on the internet to send mail for this domain.",
  },
  SPF_NEUTRAL_ALL: {
    check: "spf",
    severity: "warning",
    message: () =>
      "The SPF record ends with ?all, which gives no verdict for senders that do not match. Consider ~all or -all.",
  },
  SPF_NO_ALL: {
    check: "spf",
    severity: "warning",
    message: () =>
      "The SPF record has no all mechanism and no redirect, so senders that do not match get a neutral result.",
  },
  SPF_PTR_USED: {
    check: "spf",
    severity: "warning",
    message: () =>
      "The SPF record uses the ptr mechanism, which RFC 7208 deprecates because it is slow and unreliable.",
  },
  SPF_REDIRECT_IGNORED: {
    check: "spf",
    severity: "info",
    message: () =>
      "The SPF record has both an all mechanism and a redirect modifier. Receivers ignore the redirect when all is present, so it was not followed.",
  },
  SPF_TOO_MANY_LOOKUPS: {
    check: "spf",
    severity: "error",
    message: ({ count, exact }) =>
      `The SPF record needs ${exact ? "" : "at least "}${count} DNS lookups, which is over the limit of 10 in RFC 7208. Receivers treat this as a permanent error.`,
  },
  SPF_INCLUDE_NO_RECORD: {
    check: "spf",
    severity: "error",
    message: ({ target }) =>
      `The SPF target ${target} does not exist or does not publish exactly one SPF record, which receivers treat as a permanent error.`,
  },
  SPF_INCLUDE_LOOP: {
    check: "spf",
    severity: "error",
    message: ({ target }) =>
      `The SPF target ${target} is already part of the include chain, so it forms a loop and was not followed again.`,
  },
  SPF_MACRO_UNRESOLVED: {
    check: "spf",
    severity: "info",
    message: ({ target }) =>
      `The SPF target ${target} uses macros, which cannot be resolved without a real message. It was counted as one lookup but not followed, so the lookup count may be understated.`,
  },
  SPF_INCLUDE_INVALID: {
    check: "spf",
    severity: "error",
    message: ({ target }) =>
      `The SPF record at ${target} has a syntax error, which receivers treat as a permanent error.`,
  },
  DMARC_MISSING: {
    check: "dmarc",
    severity: "warning",
    message: () =>
      "No DMARC record was found at the _dmarc name. If this is a subdomain, a policy on a parent domain may apply, but this API does not evaluate inheritance.",
  },
  DMARC_MULTIPLE_RECORDS: {
    check: "dmarc",
    severity: "error",
    message: ({ count }) =>
      `${count} DMARC records were found at the _dmarc name. A domain must publish exactly one, and receivers ignore DMARC when there are several.`,
  },
  DMARC_SYNTAX_ERROR: {
    check: "dmarc",
    severity: "error",
    message: ({ tag, detail }) =>
      `The DMARC ${tag} tag is not valid: ${detail}.`,
  },
  DMARC_INVALID_POLICY: {
    check: "dmarc",
    severity: "error",
    message: ({ detail }) =>
      `The DMARC record needs a p tag set to none, quarantine or reject: ${detail}.`,
  },
  DMARC_POLICY_NONE: {
    check: "dmarc",
    severity: "info",
    message: () =>
      "The DMARC policy is p=none, which is monitoring only and asks receivers to take no action on mail that fails.",
  },
  DMARC_PARTIAL_PCT: {
    check: "dmarc",
    severity: "info",
    message: ({ pct }) =>
      `The DMARC policy applies to only ${pct} percent of mail (pct=${pct}).`,
  },
  DMARC_NO_RUA: {
    check: "dmarc",
    severity: "info",
    message: () =>
      "No rua tag, so no DMARC aggregate reports are being collected for this domain.",
  },
  MX_MISSING: {
    check: "mx",
    severity: "warning",
    message: () =>
      "No MX records were found, so this domain cannot receive mail through MX and would rely on implicit A-record fallback at best. That may be intentional for a send-only domain.",
  },
  MX_NULL: {
    check: "mx",
    severity: "info",
    message: () =>
      "This domain publishes a null MX record, explicitly declaring that it accepts no email.",
  },
  MX_NULL_MIXED: {
    check: "mx",
    severity: "error",
    message: () =>
      "A null MX record is published alongside other MX records, which contradicts itself. A domain that accepts no mail should publish only the null MX.",
  },
  MX_TARGET_IS_IP: {
    check: "mx",
    severity: "error",
    message: ({ exchange }) =>
      `The MX target ${exchange} is an IP address, but MX targets must be hostnames.`,
  },
  MX_TARGET_UNRESOLVABLE: {
    check: "mx",
    severity: "error",
    message: ({ exchange }) =>
      `The MX target ${exchange} has no A or AAAA records, so mail servers cannot connect to it.`,
  },
};

export const ISSUE_CODES = Object.keys(ISSUE_REGISTRY) as IssueCode[];

/** Build an issue. `check` is only needed for DNS_LOOKUP_FAILED, which belongs to any check. */
export function makeIssue<C extends IssueCode>(
  code: C,
  params: IssueParams[C],
  check?: CheckName,
): Issue {
  const def = ISSUE_REGISTRY[code] as IssueDef<C>;
  return {
    code,
    severity: def.severity,
    check: check ?? def.check,
    message: def.message(params),
  };
}

/** Fixed limitations (SCOPE-1). The first two are the minimum the spec requires. */
export const LIMITATIONS: readonly string[] = [
  "DKIM was not checked; it requires a selector.",
  "This is a DNS configuration check, not an email deliverability test.",
  "DMARC policy inheritance from a parent domain is not evaluated.",
];
