import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import type { Issue } from "../../src/core/types.js";
import { generateZone, type Zone } from "./fake-dns.js";

export interface Vector {
  id: string;
  rules: string[];
  note?: string;
  input: Record<string, unknown> | string | null;
  expect: Record<string, unknown>;
}

/** Vectors are loaded straight from spec/vectors; they are never copied into tests. */
export function loadVectors(file: string): Vector[] {
  const url = new URL(`../../spec/vectors/${file}`, import.meta.url);
  const parsed = JSON.parse(readFileSync(fileURLToPath(url), "utf8")) as {
    vectors: Vector[];
  };
  return parsed.vectors;
}

export function vectorTitle(v: Vector): string {
  return `${v.id} [${v.rules.join(", ")}]${v.note ? ` ${v.note}` : ""}`;
}

export interface DnsVectorInput {
  domain: string;
  dns: Zone | string;
}

export function zoneOf(input: DnsVectorInput): Zone {
  if (typeof input.dns === "string") {
    return generateZone(input.dns.replace(/^GENERATE:/, ""));
  }
  return input.dns;
}

/** vectors/README.md "Matching semantics for expect". */
export function assertCheckExpect(
  actual: { issues: Issue[] } & Record<string, unknown>,
  expected: Record<string, unknown>,
): void {
  for (const [key, want] of Object.entries(expected)) {
    switch (key) {
      case "issue_codes":
        expect(actual.issues.map((i) => i.code)).toEqual(want);
        break;
      case "issue_severities":
        expect(actual.issues.map((i) => i.severity)).toEqual(want);
        break;
      case "records_last": {
        const records = actual["records"] as unknown[];
        expect(records[records.length - 1]).toEqual(want);
        break;
      }
      case "message_contains":
        for (const fragment of want as string[]) {
          expect(actual.issues[0]?.message).toContain(fragment);
        }
        break;
      default:
        expect(actual[key], key).toEqual(want);
    }
  }
}
