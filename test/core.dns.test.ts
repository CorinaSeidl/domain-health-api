import { describe, expect, it } from "vitest";
import { checkDomain } from "../src/core/check.js";
import { DnsClient, classifyError, type RawResolver } from "../src/core/dns.js";
import { fakeResolver } from "./harness/fake-dns.js";

const never = new Promise<never>(() => {});

function stubResolver(overrides: Partial<RawResolver>): RawResolver {
  return {
    resolveTxt: () => Promise.resolve([["x"]]),
    resolveMx: () =>
      Promise.resolve([{ priority: 1, exchange: "mx.example.com" }]),
    resolve4: () => Promise.resolve(["192.0.2.1"]),
    resolve6: () => Promise.resolve(["2001:db8::1"]),
    ...overrides,
  };
}

describe("DNS layer (SPEC.md §3)", () => {
  it("DNS-1 every lookup goes through the injected resolver", async () => {
    const resolver = fakeResolver({
      "example.com": {
        TXT: [["v=spf1 -all"]],
        MX: [{ priority: 10, exchange: "mx.example.com" }],
      },
      "mx.example.com": { A: ["192.0.2.1"] },
    });
    await checkDomain("example.com", resolver);
    expect(resolver.calls.length).toBeGreaterThan(0);
    expect(new Set(resolver.calls)).toEqual(
      new Set([
        "TXT example.com",
        "TXT _dmarc.example.com",
        "MX example.com",
        "A mx.example.com",
        "AAAA mx.example.com",
      ]),
    );
  });

  it("DNS-2 classifies ENODATA, ENOTFOUND and anything else", () => {
    expect(classifyError({ code: "ENODATA" })).toEqual({ kind: "no_records" });
    expect(classifyError({ code: "ENOTFOUND" })).toEqual({ kind: "nxdomain" });
    expect(classifyError({ code: "ESERVFAIL" })).toEqual({
      kind: "error",
      reason: "failure",
    });
    expect(classifyError({ code: "ETIMEOUT" })).toEqual({
      kind: "error",
      reason: "failure",
    });
    expect(classifyError(new Error("boom"))).toEqual({
      kind: "error",
      reason: "failure",
    });
    expect(classifyError(null)).toEqual({ kind: "error", reason: "failure" });
  });

  it("DNS-2 a successful but empty answer is no_records, a non-empty one is found", async () => {
    const dns = new DnsClient(
      stubResolver({
        resolveTxt: (n) => Promise.resolve(n === "empty.test" ? [] : [["a"]]),
      }),
    );
    expect(await dns.txt("empty.test")).toEqual({ kind: "no_records" });
    expect(await dns.txt("full.test")).toEqual({
      kind: "found",
      records: ["a"],
    });
  });

  it("DNS-5 joins the strings of one TXT record with no separator", async () => {
    const dns = new DnsClient(
      stubResolver({
        resolveTxt: () => Promise.resolve([["v=spf1 ", "-all"], ["b"]]),
      }),
    );
    expect(await dns.txt("example.com")).toEqual({
      kind: "found",
      records: ["v=spf1 -all", "b"],
    });
  });

  it("DNS-3 lookups still pending when the budget runs out resolve as error", async () => {
    const dns = new DnsClient(stubResolver({ resolveTxt: () => never }), {
      budgetMs: 20,
    });
    expect(await dns.txt("slow.test")).toEqual({
      kind: "error",
      reason: "budget",
    });
  });

  it("DNS-3 lookups after the budget is exhausted are refused without querying", async () => {
    let t = 0;
    let queries = 0;
    const dns = new DnsClient(
      stubResolver({
        resolveTxt: () => {
          queries += 1;
          return Promise.resolve([["x"]]);
        },
      }),
      { budgetMs: 8000, now: () => t },
    );
    expect(await dns.txt("a.test")).toMatchObject({ kind: "found" });
    t = 8000;
    expect(await dns.txt("b.test")).toEqual({
      kind: "error",
      reason: "budget",
    });
    expect(queries).toBe(1);
  });

  it("DNS-3 a budget error becomes DNS_LOOKUP_FAILED for the affected check (DNS-8)", async () => {
    const resolver = stubResolver({ resolveTxt: () => never });
    const { result } = await checkDomain("example.com", resolver, {
      dns: { budgetMs: 20 },
    });
    expect(result.spf.status).toBe("error");
    expect(result.dmarc.status).toBe("error");
    expect(result.summary.status).toBe("incomplete");
  });

  it("DNS-4 refuses lookups past the cap with reason query_cap", async () => {
    let queries = 0;
    const dns = new DnsClient(
      stubResolver({
        resolveTxt: () => {
          queries += 1;
          return Promise.resolve([["x"]]);
        },
      }),
      { maxQueries: 2 },
    );
    expect(await dns.txt("a.test")).toMatchObject({ kind: "found" });
    expect(await dns.txt("b.test")).toMatchObject({ kind: "found" });
    expect(await dns.txt("c.test")).toEqual({
      kind: "error",
      reason: "query_cap",
    });
    expect(queries).toBe(2);
    expect(dns.queriesUsed).toBe(2);
  });

  it("DNS-4 the cap is shared across SPF, DMARC and MX in one request", async () => {
    const resolver = fakeResolver({
      "example.com": {
        TXT: [["v=spf1 -all"]],
        MX: [{ priority: 10, exchange: "mx.example.com" }],
      },
      "mx.example.com": { A: ["192.0.2.1"] },
    });
    const { result, dnsQueries } = await checkDomain("example.com", resolver, {
      dns: { maxQueries: 3 },
    });
    expect(dnsQueries).toBe(3);
    // The MX target lookups were refused, so the target is unchecked rather than missing.
    expect(result.mx.records[0]?.resolves).toBeNull();
  });

  it("DNS-4 SPF-18 a repeated lookup is served from cache and does not count toward the cap", async () => {
    const resolver = fakeResolver({ "a.test": { TXT: [["x"]] } });
    const dns = new DnsClient(resolver, { maxQueries: 1 });
    await dns.txt("a.test");
    await dns.txt("A.TEST.");
    expect(dns.queriesUsed).toBe(1);
    expect(resolver.calls).toEqual(["TXT a.test"]);
  });

  it("DNS-6 the top-level lookups are all issued before any of them completes", async () => {
    const calls: string[] = [];
    const resolver = stubResolver({
      resolveTxt: (name) => {
        calls.push(`TXT ${name}`);
        return new Promise(() => {});
      },
      resolveMx: (name) => {
        calls.push(`MX ${name}`);
        return new Promise(() => {});
      },
    });
    void checkDomain("example.com", resolver);
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 5));
    expect(new Set(calls)).toEqual(
      new Set(["TXT example.com", "TXT _dmarc.example.com", "MX example.com"]),
    );
  });
});
