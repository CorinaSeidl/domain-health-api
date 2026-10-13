import { describe, expect, it } from "vitest";
import { checkDomain } from "../src/core/check.js";
import { DnsClient } from "../src/core/dns.js";
import { checkSpf } from "../src/core/spf.js";
import { fakeResolver } from "./harness/fake-dns.js";

describe("SPF evaluation details (SPEC.md §4.4)", () => {
  it("SPF-18 SPF-15 a diamond is fetched once and counted on every path", async () => {
    const resolver = fakeResolver({
      "example.com": {
        TXT: [["v=spf1 include:a.example.net include:b.example.net -all"]],
      },
      "a.example.net": { TXT: [["v=spf1 include:shared.example.org ~all"]] },
      "b.example.net": { TXT: [["v=spf1 include:shared.example.org ~all"]] },
      "shared.example.org": { TXT: [["v=spf1 a ip4:192.0.2.0/24 ~all"]] },
    });
    const dns = new DnsClient(resolver);
    const spf = await checkSpf("example.com", dns);
    expect(spf.lookup_count).toBe(6); // a, b, shared (x2), plus the `a` inside shared (x2)
    expect(spf.issues).toEqual([]);
    expect(
      resolver.calls.filter((c) => c === "TXT shared.example.org"),
    ).toHaveLength(1);
    expect(dns.queriesUsed).toBe(4); // example.com, a, b, shared
  });

  it("SPF-18 a redirect back to an ancestor is a loop", async () => {
    const { result } = await checkDomain(
      "example.com",
      fakeResolver({
        "example.com": { TXT: [["v=spf1 redirect=example.net"]] },
        "example.net": { TXT: [["v=spf1 redirect=example.com"]] },
      }),
    );
    expect(result.spf.issues.map((i) => i.code)).toEqual(["SPF_INCLUDE_LOOP"]);
    expect(result.spf.status).toBe("invalid");
  });

  it("SPF-18 a missing diamond target is reported once, not once per path", async () => {
    const spf = await checkSpf(
      "example.com",
      new DnsClient(
        fakeResolver({
          "example.com": {
            TXT: [["v=spf1 include:a.example.net include:b.example.net -all"]],
          },
          "a.example.net": { TXT: [["v=spf1 include:gone.example.org ~all"]] },
          "b.example.net": { TXT: [["v=spf1 include:gone.example.org ~all"]] },
        }),
      ),
    );
    expect(spf.issues.map((i) => i.code)).toEqual(["SPF_INCLUDE_NO_RECORD"]);
  });

  it("SPF-17 a target with more than one SPF record is SPF_INCLUDE_NO_RECORD", async () => {
    const { result } = await checkDomain(
      "example.com",
      fakeResolver({
        "example.com": { TXT: [["v=spf1 include:example.net -all"]] },
        "example.net": { TXT: [["v=spf1 -all"], ["v=spf1 ~all"]] },
      }),
    );
    expect(result.spf.issues.map((i) => i.code)).toEqual([
      "SPF_INCLUDE_NO_RECORD",
    ]);
  });

  it("SPF-15 SPF-21 a redirect target is followed and counted, and its syntax errors surface as SPF_INCLUDE_INVALID", async () => {
    const spf = await checkSpf(
      "example.com",
      new DnsClient(
        fakeResolver({
          "example.com": { TXT: [["v=spf1 redirect=example.net"]] },
          "example.net": { TXT: [["v=spf1 bogus -all"]] },
        }),
      ),
    );
    expect(spf.lookup_count).toBe(1);
    expect(spf.issues.map((i) => i.code)).toEqual(["SPF_INCLUDE_INVALID"]);
  });

  it("SPF-22 SPF-16 a chain of 11 includes stops recursing as soon as the count passes 10", async () => {
    const zone: Record<string, { TXT: string[][] }> = {
      "example.com": { TXT: [["v=spf1 include:d1.example.net -all"]] },
    };
    for (let i = 1; i <= 15; i++) {
      zone[`d${i}.example.net`] = {
        TXT: [[`v=spf1 include:d${i + 1}.example.net`]],
      };
    }
    const resolver = fakeResolver(zone);
    const spf = await checkSpf("example.com", new DnsClient(resolver));
    expect(spf.lookup_count).toBe(11);
    expect(spf.lookup_count_exact).toBe(false);
    // example.com plus d1..d10; d11 is counted but never fetched
    expect(resolver.calls.filter((c) => c.startsWith("TXT d"))).toHaveLength(
      10,
    );
  });

  it("SPF-4 mechanism names and qualifiers are case-insensitive", async () => {
    const spf = await checkSpf(
      "example.com",
      new DnsClient(
        fakeResolver({
          "example.com": { TXT: [["V=SPF1 IP4:192.0.2.1 MX -ALL"]] },
        }),
      ),
    );
    expect(spf.issues).toEqual([]);
    expect(spf.all_qualifier).toBe("-");
    expect(spf.lookup_count).toBe(1);
  });
});
