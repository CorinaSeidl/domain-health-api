import { describe, expect, it } from "vitest";
import { checkDomain } from "../src/core/check.js";
import { DnsClient } from "../src/core/dns.js";
import { checkDmarc } from "../src/core/dmarc.js";
import { fakeResolver } from "./harness/fake-dns.js";
import { schemaValidator } from "./harness/openapi.js";
import {
  assertCheckExpect,
  loadVectors,
  vectorTitle,
  zoneOf,
  type DnsVectorInput,
} from "./harness/vectors.js";

const validate = schemaValidator("DomainCheckResult");

describe("dmarc.json (SPEC.md §5)", () => {
  for (const v of loadVectors("dmarc.json")) {
    it(vectorTitle(v), async () => {
      const input = v.input as unknown as DnsVectorInput;
      const resolver = fakeResolver(zoneOf(input));
      const dmarc = await checkDmarc(input.domain, new DnsClient(resolver));
      assertCheckExpect(dmarc as never, v.expect);

      // The full response must also satisfy openapi.yaml (Acceptance #3).
      const { result } = await checkDomain(
        input.domain,
        fakeResolver(zoneOf(input)),
      );
      expect(validate(result)).toBeNull();
    });
  }
});
