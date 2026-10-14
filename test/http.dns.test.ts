import { readdirSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, vi } from "vitest";
import { checkDomain } from "../src/core/check.js";
import { DnsClient, type RawResolver } from "../src/core/dns.js";
import {
  ISSUE_CODES,
  ISSUE_REGISTRY,
  LIMITATIONS,
  makeIssue,
  type IssueParams,
} from "../src/core/issues.js";
import type { Issue } from "../src/core/types.js";
import { fakeResolver, type Zone } from "./harness/fake-dns.js";
import { GOOD_ZONE, makeApp, scenario } from "./harness/http.js";
import { loadVectors, zoneOf, type DnsVectorInput } from "./harness/vectors.js";

/** Runs `work` under fake timers, ticking until it settles; returns its result and virtual elapsed ms. */
async function withFakeTime<T>(
  work: () => Promise<T>,
): Promise<{ value: T; elapsedMs: number }> {
  vi.useFakeTimers();
  try {
    const start = Date.now();
    let done = false;
    const pending = work().finally(() => {
      done = true;
    });
    let end = start;
    while (!done) {
      await vi.advanceTimersByTimeAsync(50);
      end = Date.now();
    }
    const value = await pending;
    return { value, elapsedMs: end - start };
  } finally {
    vi.useRealTimers();
  }
}

function delayed(
  inner: RawResolver,
  ms: number,
  only?: (call: string) => boolean,
): RawResolver {
  const wrap =
    <R>(type: string, fn: (name: string) => Promise<R>) =>
    (name: string): Promise<R> => {
      if (only && !only(`${type} ${name}`)) return fn(name);
      return new Promise<R>((resolve, reject) => {
        setTimeout(() => fn(name).then(resolve, reject), ms);
      });
    };
  return {
    resolveTxt: wrap("TXT", (n) => inner.resolveTxt(n)),
    resolveMx: wrap("MX", (n) => inner.resolveMx(n)),
    resolve4: wrap("A", (n) => inner.resolve4(n)),
    resolve6: wrap("AAAA", (n) => inner.resolve6(n)),
  };
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => `${e.parentPath}/${e.name}`);
}

describe("DNS and response-assembly behavior (SPEC.md §3, §7, §1.3)", () => {
  scenario(
    "H-32",
    "the production resolver is built only in the Vercel adapter, and core has no network access",
    () => {
      const root = fileURLToPath(new URL("..", import.meta.url));
      const rel = (f: string) => relative(root, f);
      const files = [
        ...sourceFiles(`${root}src`),
        ...sourceFiles(`${root}api`),
      ];
      const constructors = files
        .filter((f) => readFileSync(f, "utf8").includes("createNodeResolver("))
        .map(rel)
        .filter((f) => f !== "src/core/dns.ts")
        .sort();
      expect(constructors).toEqual(["src/http/vercel.ts"]);
      const network = /node:(dns|http|https|tls|dgram)|\bfetch\(/;
      // The only outbound call besides DNS is the Upstash REST store (D-1); it never contacts
      // a user-supplied domain, so it may use fetch but still no raw sockets or node:dns.
      const storeFile = "src/http/store/upstash.ts";
      // The landing page's script text (LP-3) calls fetch in the visitor's browser only.
      const browserFile = "src/http/landing-script.ts";
      const offenders = files
        .map(rel)
        .filter((f) => f !== "src/core/dns.ts" && f !== browserFile)
        .filter((f) => {
          const text = readFileSync(`${root}${f}`, "utf8");
          return f === storeFile
            ? /node:(dns|http|https|tls|dgram)/.test(text)
            : network.test(text);
        });
      expect(offenders).toEqual([]);
    },
  );

  scenario(
    "H-33",
    "resolver errors are classified into DNS-2 outcomes",
    async () => {
      const expected: [string, string][] = [
        ["ENODATA", "no_records"],
        ["ENOTFOUND", "nxdomain"],
        ["ESERVFAIL", "error"],
        ["ETIMEOUT", "error"],
        ["ECONNREFUSED", "error"],
        ["EWHATEVER", "error"],
      ];
      for (const [code, kind] of expected) {
        const dns = new DnsClient({
          resolveTxt: () =>
            Promise.reject(Object.assign(new Error(code), { code })),
          resolveMx: () =>
            Promise.reject(Object.assign(new Error(code), { code })),
          resolve4: () =>
            Promise.reject(Object.assign(new Error(code), { code })),
          resolve6: () =>
            Promise.reject(Object.assign(new Error(code), { code })),
        });
        expect((await dns.txt("example.com")).kind, code).toBe(kind);
      }
    },
  );

  scenario(
    "H-34",
    "a slow resolver cannot push a request past the 8 s budget",
    async () => {
      const zone: Zone = {
        "example.com": { TXT: [["v=spf1 include:a.test -all"]] },
        "a.test": { TXT: [["v=spf1 include:b.test -all"]] },
        "b.test": { TXT: [["v=spf1 include:c.test -all"]] },
        "c.test": { TXT: [["v=spf1 include:d.test -all"]] },
        "d.test": { TXT: [["v=spf1 -all"]] },
      };
      const app = makeApp({ resolver: delayed(fakeResolver(zone), 2500) });
      const { value: res, elapsedMs } = await withFakeTime(() =>
        app.check("example.com"),
      );
      expect(res.status).toBe(200);
      expect(elapsedMs).toBeLessThanOrEqual(9000);
      const body = (await res.json()) as {
        summary: { status: string };
        spf: { lookup_count_exact: boolean | null };
        issues: { code: string }[];
      };
      expect(["warn", "incomplete", "fail"]).toContain(body.summary.status);
      expect(body.spf.lookup_count_exact).toBe(false);
      expect(body.issues.map((i) => i.code)).toContain("DNS_LOOKUP_FAILED");
    },
  );

  scenario("H-35", "the three top-level lookups run concurrently", async () => {
    const top = new Set([
      "TXT example.com",
      "TXT _dmarc.example.com",
      "MX example.com",
    ]);
    const app = makeApp({
      resolver: delayed(fakeResolver(GOOD_ZONE), 1000, (c) => top.has(c)),
    });
    const { value: res, elapsedMs } = await withFakeTime(() =>
      app.check("example.com"),
    );
    expect(res.status).toBe(200);
    expect(elapsedMs).toBeLessThan(2000);
    expect(elapsedMs).toBeGreaterThanOrEqual(1000);
  });

  scenario(
    "H-36",
    "every issue across all vectors has the exact shape, the §9 severity and a plain message",
    async () => {
      const registry = new Map<string, { check: string; severity: string }>();
      const spec = readFileSync(
        new URL("../spec/SPEC.md", import.meta.url),
        "utf8",
      );
      for (const m of spec.matchAll(/^\| `([A-Z_]+)` \| (\w+) \| (\w+) \|/gm)) {
        registry.set(m[1]!, { check: m[2]!, severity: m[3]! });
      }
      expect(registry.size).toBe(ISSUE_CODES.length);

      const issues: Issue[] = [];
      for (const file of ["spf.json", "dmarc.json", "mx.json", "check.json"]) {
        for (const v of loadVectors(file)) {
          const input = v.input as unknown as DnsVectorInput;
          const { result } = await checkDomain(
            input.domain,
            fakeResolver(zoneOf(input)),
          );
          issues.push(...result.issues);
        }
      }
      expect(issues.length).toBeGreaterThan(0);
      for (const issue of issues) {
        expect(Object.keys(issue).sort()).toEqual([
          "check",
          "code",
          "message",
          "severity",
        ]);
        const def = registry.get(issue.code);
        expect(def, issue.code).toBeDefined();
        expect(issue.severity, issue.code).toBe(def!.severity);
        if (def!.check !== "any")
          expect(issue.check, issue.code).toBe(def!.check);
        expect(issue.message.length).toBeGreaterThan(0);
        expect(issue.message, issue.code).not.toMatch(/[*`#\n]/);
      }
    },
  );

  scenario(
    "H-37",
    "no message template or limitation says deliver, safe, compliant or guarantee",
    () => {
      const params = {
        DOMAIN_NOT_FOUND: { domain: "example.com" },
        DNS_LOOKUP_FAILED: { record: "TXT example.com" },
        SPF_MISSING: {},
        SPF_MULTIPLE_RECORDS: { count: 2 },
        SPF_SYNTAX_ERROR: { detail: "x" },
        SPF_ALLOW_ALL: {},
        SPF_NEUTRAL_ALL: {},
        SPF_NO_ALL: {},
        SPF_PTR_USED: {},
        SPF_REDIRECT_IGNORED: {},
        SPF_TOO_MANY_LOOKUPS: { count: 11, exact: true },
        SPF_INCLUDE_NO_RECORD: { target: "a.test" },
        SPF_INCLUDE_LOOP: { target: "a.test" },
        SPF_MACRO_UNRESOLVED: { target: "a.test" },
        SPF_INCLUDE_INVALID: { target: "a.test" },
        DMARC_MISSING: {},
        DMARC_MULTIPLE_RECORDS: { count: 2 },
        DMARC_SYNTAX_ERROR: { tag: "p", detail: "x" },
        DMARC_INVALID_POLICY: { detail: "x" },
        DMARC_POLICY_NONE: {},
        DMARC_PARTIAL_PCT: { pct: 50 },
        DMARC_NO_RUA: {},
        MX_MISSING: {},
        MX_NULL: {},
        MX_NULL_MIXED: {},
        MX_TARGET_IS_IP: { exchange: "192.0.2.1" },
        MX_TARGET_UNRESOLVABLE: { exchange: "mx.test" },
      } satisfies { [C in keyof IssueParams]: IssueParams[C] };
      const banned = /deliver|safe|compliant|guarantee/i;
      expect(Object.keys(params).sort()).toEqual([...ISSUE_CODES].sort());
      for (const code of ISSUE_CODES) {
        const issue = makeIssue(code, params[code] as never, "spf");
        expect(issue.message, code).not.toMatch(banned);
      }
      expect(Object.keys(ISSUE_REGISTRY)).toHaveLength(ISSUE_CODES.length);
      const fixed = "not an email deliverability test";
      for (const limitation of LIMITATIONS) {
        expect(limitation.replace(fixed, ""), limitation).not.toMatch(banned);
      }
    },
  );
});
