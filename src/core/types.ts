export type Severity = "error" | "warning" | "info";
export type CheckName = "domain" | "spf" | "dmarc" | "mx";

export interface Issue {
  code: string;
  severity: Severity;
  check: CheckName;
  message: string;
}

export type CheckStatus =
  "valid" | "invalid" | "missing" | "error" | "not_evaluated";

export interface SpfResult {
  status: CheckStatus;
  record: string | null;
  records: string[];
  all_qualifier: "+" | "-" | "~" | "?" | null;
  lookup_count: number | null;
  lookup_count_exact: boolean | null;
  issues: Issue[];
}

export interface DmarcResult {
  status: CheckStatus;
  record: string | null;
  records: string[];
  policy: "none" | "quarantine" | "reject" | null;
  subdomain_policy: "none" | "quarantine" | "reject" | null;
  pct: number | null;
  adkim: "r" | "s" | null;
  aspf: "r" | "s" | null;
  rua: string[];
  ruf: string[];
  issues: Issue[];
}

export interface MxRecord {
  priority: number;
  exchange: string;
  resolves: boolean | null;
}

export interface MxResult {
  status: CheckStatus | "null_mx";
  records: MxRecord[];
  issues: Issue[];
}

export interface DomainCheckResult {
  request_id: string;
  domain: string;
  domain_exists: boolean;
  checked_at: string;
  summary: {
    status: "pass" | "warn" | "fail" | "incomplete";
    errors: number;
    warnings: number;
    info: number;
  };
  spf: SpfResult;
  dmarc: DmarcResult;
  mx: MxResult;
  issues: Issue[];
  limitations: string[];
}
