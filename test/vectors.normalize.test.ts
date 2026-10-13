import { describe, expect, it } from "vitest";
import { normalizeDomain } from "../src/core/normalize.js";
import { generateName } from "./harness/fake-dns.js";
import { loadVectors, vectorTitle } from "./harness/vectors.js";

describe("normalize.json (SPEC.md §2)", () => {
  for (const v of loadVectors("normalize.json")) {
    it(vectorTitle(v), () => {
      let input = v.input as string | null;
      if (
        typeof input === "string" &&
        input.startsWith("GENERATE:total_length_")
      ) {
        input = generateName(
          Number(input.replace("GENERATE:total_length_", "")),
        );
      }
      const want = v.expect as {
        ok: boolean;
        domain?: string;
        error_code?: string;
        message_contains?: string[];
      };
      const got = normalizeDomain(input);
      expect(got.ok).toBe(want.ok);
      if (got.ok) {
        if (want.domain !== undefined) expect(got.domain).toBe(want.domain);
      } else {
        expect(got.code).toBe(want.error_code);
        expect(got.message.length).toBeGreaterThan(0); // IN-8
        for (const fragment of want.message_contains ?? []) {
          expect(got.message).toContain(fragment);
        }
      }
    });
  }

  it("generateName builds names of the exact requested length", () => {
    expect(generateName(253)).toHaveLength(253);
    expect(generateName(254)).toHaveLength(254);
  });
});
