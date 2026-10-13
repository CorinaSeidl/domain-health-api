import { describe, expect, it } from "vitest";
import { checkDomain } from "../src/core/check.js";
import { fakeResolver } from "./harness/fake-dns.js";
import { schemaValidator } from "./harness/openapi.js";
import {
  loadVectors,
  vectorTitle,
  zoneOf,
  type DnsVectorInput,
} from "./harness/vectors.js";

const validate = schemaValidator("DomainCheckResult");

interface CheckExpect {
  domain_exists?: boolean;
  summary?: unknown;
  check_status?: Record<string, string>;
  issue_codes?: string[];
  limitations_min_length?: number;
  max_dns_queries?: number;
  spf_issue_codes_include?: string[];
  deterministic?: boolean;
}

describe("check.json (SPEC.md §3, §7, §1.3)", () => {
  for (const v of loadVectors("check.json")) {
    it(vectorTitle(v), async () => {
      const input = v.input as unknown as DnsVectorInput;
      const want = v.expect as CheckExpect;
      const fixed = {
        now: () => new Date("2026-10-13T08:00:00Z"),
        requestId: "test-request",
      };
      const first = fakeResolver(zoneOf(input));
      const { result, dnsQueries } = await checkDomain(
        input.domain,
        first,
        fixed,
      );

      expect(validate(result)).toBeNull(); // Acceptance #3

      if (want.domain_exists !== undefined)
        expect(result.domain_exists).toBe(want.domain_exists);
      if (want.summary !== undefined)
        expect(result.summary).toEqual(want.summary);
      if (want.check_status !== undefined) {
        for (const [check, status] of Object.entries(want.check_status)) {
          expect(result[check as "spf" | "dmarc" | "mx"].status, check).toBe(
            status,
          );
        }
      }
      if (want.issue_codes !== undefined) {
        expect(result.issues.map((i) => i.code)).toEqual(want.issue_codes);
      }
      if (want.limitations_min_length !== undefined) {
        expect(result.limitations.length).toBeGreaterThanOrEqual(
          want.limitations_min_length,
        );
      }
      if (want.max_dns_queries !== undefined) {
        expect(dnsQueries).toBeLessThanOrEqual(want.max_dns_queries);
        expect(first.calls.length).toBeLessThanOrEqual(want.max_dns_queries);
      }
      for (const code of want.spf_issue_codes_include ?? []) {
        expect(result.spf.issues.map((i) => i.code)).toContain(code);
      }
      if (want.deterministic) {
        const shuffled = fakeResolver(zoneOf(input), { shuffle: true });
        const second = await checkDomain(input.domain, shuffled, fixed);
        expect(JSON.stringify(second.result)).toBe(JSON.stringify(result));
      }
    });
  }
});
