import { pathToFileURL } from "node:url";
import { createNodeResolver } from "../src/core/dns.js";
import type { DomainCheckResult } from "../src/core/types.js";
import { createHandler } from "../src/http/handler.js";
import { hashKey } from "../src/http/auth.js";
import { MemoryStore } from "../src/http/store/memory.js";
import { VERSION } from "../src/version.js";
import { generateKey } from "./issue-key.js";

/**
 * Acceptance #4 and #6 (SPEC.md §12): a live run against real domains. Run it only from
 * .github/workflows/smoke.yml or a local machine, never from a Claude Code cloud sandbox,
 * where DNS is filtered and every real domain would look nonexistent (BUILD_BRIEF "Environments").
 *
 * Default: in-process, with the production resolver and an ephemeral key. With SMOKE_BASE_URL
 * and SMOKE_API_KEY it calls a deployed API instead (Acceptance #5).
 */

/** `.example` is reserved by RFC 2606 and never delegated, so it is always NXDOMAIN. */
const NONEXISTENT = "domain-health-smoke-nxdomain.example";

type Send = (domain: string) => Promise<Response>;

function inProcess(logs: string[]): { send: Send; key: string } {
  const key = generateKey();
  const handle = createHandler({
    resolver: createNodeResolver(),
    keyHashes: new Set([hashKey(key)]),
    limits: { perMinute: 60, perDay: 1000 },
    store: new MemoryStore(),
    log: (line) => logs.push(line),
    version: VERSION,
  });
  return {
    key,
    send: (domain) =>
      handle(
        new Request(
          `https://smoke.invalid/v1/domain/check?domain=${encodeURIComponent(domain)}`,
          { headers: { authorization: `Bearer ${key}` } },
        ),
      ),
  };
}

function remote(baseUrl: string, key: string): Send {
  return (domain) =>
    fetch(`${baseUrl}/v1/domain/check?domain=${encodeURIComponent(domain)}`, {
      headers: { authorization: `Bearer ${key}` },
    });
}

function describeResult(r: DomainCheckResult): string[] {
  const codes =
    r.issues.map((i) => `${i.severity}:${i.code}`).join(", ") || "none";
  return [
    `  summary: ${r.summary.status} (errors ${r.summary.errors}, warnings ${r.summary.warnings}, info ${r.summary.info})`,
    `  domain_exists: ${r.domain_exists}`,
    `  spf: ${r.spf.status} ${r.spf.record ?? "(no record)"} lookups=${r.spf.lookup_count}`,
    `  dmarc: ${r.dmarc.status} ${r.dmarc.record ?? "(no record)"}`,
    `  mx: ${r.mx.status} ${r.mx.records.map((m) => `${m.priority} ${m.exchange || "."}`).join("; ") || "(none)"}`,
    `  issues: ${codes}`,
  ];
}

export interface Target {
  domain: string;
  label: string;
  /** Hard expectations; the rest is for a human to review. Returns failure messages. */
  verify?: (r: DomainCheckResult) => string[];
}

export function targets(ownDomain: string): Target[] {
  return [
    { domain: "google.com", label: "google.com" },
    { domain: "github.com", label: "github.com" },
    {
      domain: "example.com",
      label: "example.com (expect null MX, SPF -all)",
      verify: (r) => [
        ...(r.mx.status === "null_mx"
          ? []
          : [`mx.status is ${r.mx.status}, expected null_mx`]),
        ...(r.spf.all_qualifier === "-"
          ? []
          : [`spf.all_qualifier is ${r.spf.all_qualifier}, expected -`]),
      ],
    },
    {
      domain: NONEXISTENT,
      label: `${NONEXISTENT} (expect DOMAIN_NOT_FOUND)`,
      verify: (r) =>
        r.issues.some((i) => i.code === "DOMAIN_NOT_FOUND")
          ? []
          : ["missing DOMAIN_NOT_FOUND"],
    },
    { domain: ownDomain, label: `${ownDomain} (your own domain)` },
  ];
}

export async function main(
  env: Record<string, string | undefined>,
  write: (line: string) => void = console.log,
): Promise<number> {
  const own = env["SMOKE_OWN_DOMAIN"]?.trim();
  if (!own) {
    write(
      "SMOKE_OWN_DOMAIN is required: Acceptance #4 needs one domain you control.",
    );
    return 2;
  }
  const baseUrl = env["SMOKE_BASE_URL"]?.replace(/\/+$/, "");
  const logs: string[] = [];
  let send: Send;
  let secrets: string[] = [];
  if (baseUrl) {
    const key = env["SMOKE_API_KEY"];
    if (!key) {
      write("SMOKE_API_KEY is required with SMOKE_BASE_URL.");
      return 2;
    }
    send = remote(baseUrl, key);
    write(`Mode: deployed API at ${baseUrl}`);
  } else {
    const local = inProcess(logs);
    send = local.send;
    secrets = [local.key];
    write("Mode: in-process handler with the production resolver");
  }

  const list = targets(own);
  let failures = 0;
  for (const t of list) {
    write(`\n${t.label}`);
    try {
      const res = await send(t.domain);
      if (res.status !== 200) {
        write(`  FAIL: HTTP ${res.status}`);
        failures++;
        continue;
      }
      const body = (await res.json()) as DomainCheckResult;
      for (const line of describeResult(body)) write(line);
      for (const problem of t.verify?.(body) ?? []) {
        write(`  FAIL: ${problem}`);
        failures++;
      }
    } catch (error) {
      write(
        `  FAIL: ${error instanceof Error ? error.message : String(error)}`,
      );
      failures++;
    }
  }

  // Acceptance #6: the run's log lines must not contain a domain or the key (USE-2).
  if (baseUrl) {
    write(
      "\nLog hygiene: not checked in deployed mode; grep the host's logs for the domains above.",
    );
  } else {
    const out = logs.join("\n");
    const leaked = [...list.map((t) => t.domain), ...secrets].filter((s) =>
      out.includes(s),
    );
    write(
      `\nLog hygiene: ${logs.length} log lines, ${leaked.length === 0 ? "no domains or keys found" : "FAIL"}`,
    );
    if (leaked.length > 0) failures++;
  }

  write(
    failures === 0
      ? "\nSmoke run finished. The automated checks passed; a human still reviews the output above."
      : `\nSmoke run finished with ${failures} failure(s).`,
  );
  return failures === 0 ? 0 : 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exit(await main(process.env));
}
