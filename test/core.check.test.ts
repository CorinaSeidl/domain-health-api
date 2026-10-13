import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkDomain } from "../src/core/check.js";
import {
  ISSUE_CODES,
  ISSUE_REGISTRY,
  LIMITATIONS,
  makeIssue,
  type IssueParams,
} from "../src/core/issues.js";
import { fakeResolver } from "./harness/fake-dns.js";
import { loadOpenApi, schemaValidator } from "./harness/openapi.js";

const FIXED = {
  now: () => new Date("2026-10-13T08:00:00Z"),
  requestId: "abc-123",
};

const SAMPLE_PARAMS: IssueParams = {
  DOMAIN_NOT_FOUND: { domain: "example.com" },
  DNS_LOOKUP_FAILED: { record: "the SPF record for example.com" },
  SPF_MISSING: {},
  SPF_MULTIPLE_RECORDS: { count: 2 },
  SPF_SYNTAX_ERROR: { detail: 'unrecognized term "foo"' },
  SPF_ALLOW_ALL: {},
  SPF_NEUTRAL_ALL: {},
  SPF_NO_ALL: {},
  SPF_PTR_USED: {},
  SPF_REDIRECT_IGNORED: {},
  SPF_TOO_MANY_LOOKUPS: { count: 11, exact: false },
  SPF_INCLUDE_NO_RECORD: { target: "example.net" },
  SPF_INCLUDE_LOOP: { target: "example.net" },
  SPF_MACRO_UNRESOLVED: { target: "%{d}.example.net" },
  SPF_INCLUDE_INVALID: { target: "example.net" },
  DMARC_MISSING: {},
  DMARC_MULTIPLE_RECORDS: { count: 2 },
  DMARC_SYNTAX_ERROR: {
    tag: "pct",
    detail: '"150" must be a whole number from 0 to 100',
  },
  DMARC_INVALID_POLICY: { detail: "the p tag is missing" },
  DMARC_POLICY_NONE: {},
  DMARC_PARTIAL_PCT: { pct: 25 },
  DMARC_NO_RUA: {},
  MX_MISSING: {},
  MX_NULL: {},
  MX_NULL_MIXED: {},
  MX_TARGET_IS_IP: { exchange: "192.0.2.25" },
  MX_TARGET_UNRESOLVABLE: { exchange: "mx.example.com" },
};

const specText = readFileSync(
  fileURLToPath(new URL("../spec/SPEC.md", import.meta.url)),
  "utf8",
);

describe("issue registry (SPEC.md §9, RES-3)", () => {
  it("RES-3 the code list matches SPEC.md §9 and the openapi.yaml enum exactly", () => {
    const section = specText.slice(
      specText.indexOf("## 9. Issue code registry"),
      specText.indexOf("## 10."),
    );
    const rows = [
      ...section.matchAll(/^\| `([A-Z_]+)` \| (\w+) \| (\w+) \|/gm),
    ].map((m) => ({
      code: m[1],
      check: m[2],
      severity: m[3],
    }));
    expect(rows.length).toBe(27);
    expect([...ISSUE_CODES].sort()).toEqual(rows.map((r) => r.code).sort());

    const openapi = loadOpenApi() as {
      components: {
        schemas: { Issue: { properties: { code: { enum: string[] } } } };
      };
    };
    expect([...ISSUE_CODES].sort()).toEqual(
      [...openapi.components.schemas.Issue.properties.code.enum].sort(),
    );

    for (const row of rows) {
      const def = ISSUE_REGISTRY[row.code as keyof IssueParams];
      expect(def.severity, `${row.code} severity`).toBe(row.severity);
      // DNS_LOOKUP_FAILED is registered as "any" and takes its check from the caller.
      if (row.check !== "any")
        expect(def.check, `${row.code} check`).toBe(row.check);
    }
  });

  it("RES-3 messages are one or two plain sentences with no markdown", () => {
    for (const code of ISSUE_CODES) {
      const message = makeIssue(
        code,
        SAMPLE_PARAMS[code] as never,
        "spf",
      ).message;
      expect(message.length, code).toBeGreaterThan(0);
      expect(message, code).not.toMatch(/[*`#_]{2,}|\[.*\]\(.*\)|\n/);
      const sentences = message.split(/(?<=[.!?])\s+/).filter(Boolean);
      expect(sentences.length, code).toBeLessThanOrEqual(2);
    }
  });

  it("SCOPE-2 no issue message says deliver, safe, compliant or guarantee", () => {
    for (const code of ISSUE_CODES) {
      const message = makeIssue(
        code,
        SAMPLE_PARAMS[code] as never,
        "spf",
      ).message;
      expect(message.toLowerCase(), code).not.toMatch(
        /deliver|safe|compliant|guarantee/,
      );
    }
  });

  it("SCOPE-2 limitations avoid the same words, except the fixed deliverability sentence", () => {
    const fixed = "not an email deliverability test";
    expect(LIMITATIONS.some((l) => l.includes(fixed))).toBe(true);
    for (const text of LIMITATIONS) {
      expect(text.replace(fixed, "").toLowerCase()).not.toMatch(
        /deliver|safe|compliant|guarantee/,
      );
    }
  });
});

describe("response assembly (SPEC.md §7)", () => {
  const zone = {
    "example.com": {
      TXT: [["v=spf1 +all"]],
      MX: [{ priority: 10, exchange: "mx.example.com" }],
    },
    "mx.example.com": { A: ["192.0.2.25"] },
  };

  it("SCOPE-1 every response says DKIM was not checked and that this is not a deliverability test", async () => {
    const { result } = await checkDomain(
      "example.com",
      fakeResolver(zone),
      FIXED,
    );
    expect(result.limitations.length).toBeGreaterThanOrEqual(2);
    expect(result.limitations.join(" ")).toMatch(/DKIM was not checked/);
    expect(result.limitations.join(" ")).toMatch(
      /not an email deliverability test/,
    );
  });

  it("RES-5 checked_at is an ISO-8601 UTC timestamp and domain is the normalized domain", async () => {
    const { result } = await checkDomain(
      "example.com",
      fakeResolver(zone),
      FIXED,
    );
    expect(result.checked_at).toBe("2026-10-13T08:00:00.000Z");
    expect(result.checked_at).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/,
    );
    expect(result.domain).toBe("example.com");
    expect(result.request_id).toBe("abc-123");
  });

  it("RES-5 a default request_id is 32 hex characters and differs between requests", async () => {
    const a = await checkDomain("example.com", fakeResolver(zone));
    const b = await checkDomain("example.com", fakeResolver(zone));
    expect(a.result.request_id).toMatch(/^[0-9a-f]{32}$/);
    expect(a.result.request_id).not.toBe(b.result.request_id);
  });

  it("RES-2 top-level issues are the check issues concatenated in order", async () => {
    const { result } = await checkDomain(
      "example.com",
      fakeResolver(zone),
      FIXED,
    );
    expect(result.issues).toEqual([
      ...result.spf.issues,
      ...result.dmarc.issues,
      ...result.mx.issues,
    ]);
    for (const issue of result.issues) {
      expect(Object.keys(issue).sort()).toEqual([
        "check",
        "code",
        "message",
        "severity",
      ]); // RES-3
    }
  });

  it("RES-1 fields are always present: a nonexistent domain still returns every key", async () => {
    const { result } = await checkDomain(
      "nope.example.com",
      fakeResolver({}),
      FIXED,
    );
    expect(Object.keys(result).sort()).toEqual(
      [
        "checked_at",
        "dmarc",
        "domain",
        "domain_exists",
        "issues",
        "limitations",
        "mx",
        "request_id",
        "spf",
        "summary",
      ].sort(),
    );
    expect(Object.keys(result.spf).sort()).toEqual(
      [
        "all_qualifier",
        "issues",
        "lookup_count",
        "lookup_count_exact",
        "record",
        "records",
        "status",
      ].sort(),
    );
    expect(Object.keys(result.dmarc)).toHaveLength(11);
  });

  it("RES-1 the OpenAPI validator rejects a response with a missing field", async () => {
    const validate = schemaValidator("DomainCheckResult");
    const { result } = await checkDomain(
      "example.com",
      fakeResolver(zone),
      FIXED,
    );
    expect(validate(result)).toBeNull();
    const broken: Partial<typeof result> = { ...result };
    delete broken.limitations;
    expect(validate(broken)).not.toBeNull();
  });

  it("RES-4 summary status precedence is fail, then incomplete, then warn, then pass", async () => {
    const run = async (z: Record<string, never> | object) =>
      (await checkDomain("example.com", fakeResolver(z as never), FIXED)).result
        .summary.status;
    const good = {
      "example.com": {
        TXT: [["v=spf1 -all"]],
        MX: [{ priority: 10, exchange: "mx.example.com" }],
      },
      "_dmarc.example.com": {
        TXT: [["v=DMARC1; p=reject; rua=mailto:d@example.com"]],
      },
      "mx.example.com": { A: ["192.0.2.1"] },
    };
    expect(await run(good)).toBe("pass");
    expect(await run({ ...good, "_dmarc.example.com": {} })).toBe("warn");
    expect(
      await run({
        ...good,
        "example.com": { ...good["example.com"], TXT: "ERROR" },
      }),
    ).toBe("incomplete");
    expect(
      await run({
        ...good,
        "example.com": { ...good["example.com"], TXT: [["v=spf1 +all"]] },
      }),
    ).toBe("fail");
    // an error-severity issue outranks a failed lookup
    expect(
      await run({
        ...good,
        "_dmarc.example.com": { TXT: "ERROR" },
        "mx.example.com": {},
      }),
    ).toBe("fail");
  });
});
