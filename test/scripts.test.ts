import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractRuleIds,
  findUncovered,
  mentions,
  stripTodos,
} from "../scripts/check-rule-coverage.js";
import { generateKey } from "../scripts/issue-key.js";
import { targets } from "../scripts/smoke.js";
import {
  buildUsageReport,
  main as usageReportMain,
} from "../scripts/usage-report.js";
import { MemoryStore } from "../src/http/store/memory.js";
import { schemaValidator } from "./harness/openapi.js";
import { readFileSync } from "node:fs";

// Fixtures use made-up IDs (ZZ-n) so they cannot mark a real SPEC rule as covered. so they cannot mark a real SPEC rule as covered.
const SPEC = `
| ID | Rule |
| **ZZ-1** | one |
| **ZZ-2** | two |
| **ZZ-10** | ten |
Prose mentioning ZZ-99 outside a table row.
`;

describe("check-rule-coverage (Acceptance #2)", () => {
  it("extracts bold table IDs", () => {
    expect(extractRuleIds(SPEC)).toEqual(["ZZ-1", "ZZ-2", "ZZ-10"]);
  });

  it("matches whole IDs only", () => {
    expect(mentions("ZZ-10 is tested", "ZZ-1")).toBe(false);
    expect(mentions("[ZZ-1] is tested", "ZZ-1")).toBe(true);
    expect(mentions("XZZ-1", "ZZ-1")).toBe(false);
  });

  it("ignores it.todo and scenario.todo placeholders, even with parens in the text", () => {
    const src = `
      it.todo("ZZ-1 (later) is pending");
      scenario.todo(
        "H-1",
        "uses ZZ-2 (M3: not covered until then)",
      );
      it("ZZ-10 real", () => { expect(1).toBe(1); });
    `;
    const stripped = stripTodos(src);
    expect(stripped).not.toContain("ZZ-1 ");
    expect(stripped).not.toContain("ZZ-2");
    expect(stripped).toContain("ZZ-10 real");
    const result = findUncovered({ spec: SPEC, tests: [src], vectorFiles: [] });
    expect(result.uncovered).toEqual(["ZZ-1", "ZZ-2"]);
  });

  it("fails on an untested rule", () => {
    const none = findUncovered({ spec: SPEC, tests: [""], vectorFiles: [] });
    expect(none).toEqual({
      total: 3,
      uncovered: ["ZZ-1", "ZZ-2", "ZZ-10"],
    });
    const all = findUncovered({
      spec: SPEC,
      tests: ["it('ZZ-1 ZZ-2 ZZ-10', () => {})"],
      vectorFiles: [],
    });
    expect(all.uncovered).toEqual([]);
  });

  it("KEY-style and LP-style rule IDs are required like any other", () => {
    const spec = "| **KEY-1** | a |\n| **KEY-5** | b |\n| **LP-1** | c |\n";
    expect(extractRuleIds(spec)).toEqual(["KEY-1", "KEY-5", "LP-1"]);
    const result = findUncovered({
      spec,
      tests: ["it('KEY-1 is tested', () => {})"],
      vectorFiles: [],
    });
    expect(result.uncovered).toEqual(["KEY-5", "LP-1"]);
  });

  it("counts data-vector rules, but an http.json scenario only once it has a real test", () => {
    const vectorFiles = [
      { name: "x.json", vectors: [{ id: "X-1", rules: ["ZZ-1"] }] },
      {
        name: "http.json",
        vectors: [
          { id: "H-1", rules: ["ZZ-2"] },
          { id: "H-2", rules: ["ZZ-10"] },
        ],
      },
    ];
    const tests = [
      `scenario("H-1", "real", () => {}); scenario.todo("H-2", "later");`,
    ];
    expect(findUncovered({ spec: SPEC, tests, vectorFiles }).uncovered).toEqual(
      ["ZZ-10"],
    );
  });
});

describe("usage-report (USE-4)", () => {
  it("USE-4 counts only days inside the inclusive range", async () => {
    const store = new MemoryStore();
    await store.recordSuccess("K1", "2026-10-06"); // before
    await store.recordSuccess("K1", "2026-10-07");
    await store.recordSuccess("K2", "2026-10-13");
    await store.recordSuccess("K2", "2026-10-14"); // after
    await store.recordSuccess("K3", "2026-10-20"); // never in range
    expect(await buildUsageReport(store, "2026-10-07", "2026-10-13")).toEqual({
      from: "2026-10-07",
      to: "2026-10-13",
      uniqueActiveKeys: 2,
      totalSuccessfulChecks: 2,
      repeatKeys: 0,
    });
  });

  it("USE-4 rejects malformed or reversed ranges", async () => {
    const store = new MemoryStore();
    await expect(
      buildUsageReport(store, "2026-13-01", "2026-13-02"),
    ).rejects.toThrow("UTC date");
    await expect(
      buildUsageReport(store, "2026-10-13", "2026-10-07"),
    ).rejects.toThrow("after");
  });

  it("USE-4 CLI reads a usage file and prints the three numbers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "usage-"));
    const file = join(dir, "usage.json");
    writeFileSync(
      file,
      JSON.stringify([
        { keyId: "aaaaaaaaaaaa", counts: { "2026-10-01": 2, "2026-10-03": 1 } },
        { keyId: "bbbbbbbbbbbb", counts: { "2026-10-02": 4 } },
      ]),
    );
    const lines: string[] = [];
    await usageReportMain(
      ["--from", "2026-10-01", "--to", "2026-10-07", "--usage-file", file],
      (l) => lines.push(l),
    );
    const out = lines.join("\n");
    expect(out).toContain("Unique active keys: 2");
    expect(out).toContain("Total successful checks: 7");
    expect(out).toContain("Repeat keys (active on 2 or more distinct days): 1");
    writeFileSync(file, JSON.stringify([{ keyId: 1 }]));
    await expect(
      usageReportMain([
        "--from",
        "2026-10-01",
        "--to",
        "2026-10-07",
        "--usage-file",
        file,
      ]),
    ).rejects.toThrow("entries must be");
  });
});

describe("issue-key (AUTH-2)", () => {
  it("AUTH-2 draws from all of base62 over many keys", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++)
      for (const c of generateKey().slice(3)) seen.add(c);
    expect(seen.size).toBeGreaterThan(55);
  });
});

describe("smoke targets (Acceptance #4)", () => {
  it("covers the five required domains and encodes the expectations", () => {
    const list = targets("mine.test");
    expect(list.map((t) => t.domain)).toEqual([
      "google.com",
      "github.com",
      "example.com",
      "domain-health-smoke-nxdomain.example",
      "mine.test",
    ]);
    const nx = list[3]!.verify!;
    expect(nx({ issues: [] } as never)).toEqual(["missing DOMAIN_NOT_FOUND"]);
    expect(nx({ issues: [{ code: "DOMAIN_NOT_FOUND" }] } as never)).toEqual([]);
  });
});

describe("README", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

  it("sample response validates against openapi.yaml", () => {
    const block = /## Sample response\s+```json\n([\s\S]*?)```/.exec(
      readme,
    )?.[1];
    expect(block).toBeDefined();
    expect(schemaValidator("DomainCheckResult")(JSON.parse(block!))).toBeNull();
  });

  it("curl example targets the placeholder host, the check path and the bearer header", () => {
    const curl = /```sh\n(curl[\s\S]*?)```/.exec(readme)?.[1] ?? "";
    expect(curl).toContain(
      "https://REPLACE_WITH_DEPLOYED_HOST/v1/domain/check?domain=example.com",
    );
    expect(curl).toContain('-H "Authorization: Bearer $DH_API_KEY"');
    expect(curl).not.toMatch(/api_key=|[?&]key=/);
  });

  it("SCOPE-2 never claims a domain will deliver or is safe or compliant", () => {
    const prose = readme.replace(/```[\s\S]*?```/g, "");
    expect(prose).not.toMatch(/will deliver|is safe|is compliant|guarantee/i);
  });
});
