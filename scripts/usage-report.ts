import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import type { KeyUsage, Store } from "../src/http/store/types.js";
import {
  UpstashStore,
  upstashConfigFromEnv,
} from "../src/http/store/upstash.js";

export interface UsageReport {
  from: string;
  to: string;
  uniqueActiveKeys: number;
  totalSuccessfulChecks: number;
  /** Keys active on at least 2 distinct UTC days within the range. */
  repeatKeys: number;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function assertDay(value: string, name: string): void {
  const time = Date.parse(`${value}T00:00:00Z`);
  const valid =
    DAY.test(value) &&
    !Number.isNaN(time) &&
    new Date(time).toISOString().startsWith(value);
  if (!valid) throw new Error(`${name} must be a UTC date like 2026-10-13.`);
}

/** USE-4. Both ends of the range are inclusive UTC days (YYYY-MM-DD, which sort as strings). */
export async function buildUsageReport(
  store: Pick<Store, "listUsage">,
  from: string,
  to: string,
): Promise<UsageReport> {
  assertDay(from, "from");
  assertDay(to, "to");
  if (from > to) throw new Error("from must not be after to.");
  const report: UsageReport = {
    from,
    to,
    uniqueActiveKeys: 0,
    totalSuccessfulChecks: 0,
    repeatKeys: 0,
  };
  for (const usage of await store.listUsage()) {
    const active = Object.entries(usage.counts).filter(
      ([day, count]) => day >= from && day <= to && count > 0,
    );
    if (active.length === 0) continue;
    report.uniqueActiveKeys += 1;
    report.repeatKeys += active.length >= 2 ? 1 : 0;
    for (const [, count] of active) report.totalSuccessfulChecks += count;
  }
  return report;
}

/**
 * Read-only Store over a JSON dump of `listUsage()` (an array of `{ keyId, counts }`). Kept
 * for offline use next to the Upstash loader below.
 */
export class UsageFileStore implements Pick<Store, "listUsage"> {
  constructor(private readonly path: string) {}

  listUsage(): Promise<KeyUsage[]> {
    const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
    if (!Array.isArray(parsed))
      throw new Error("Usage file must be a JSON array.");
    for (const item of parsed as Partial<KeyUsage>[]) {
      const ok =
        typeof item?.keyId === "string" &&
        typeof item.counts === "object" &&
        item.counts !== null &&
        Object.values(item.counts).every((n) => Number.isInteger(n) && n >= 0);
      if (!ok)
        throw new Error(
          "Usage file entries must be { keyId, counts: { day: n } }.",
        );
    }
    return Promise.resolve(parsed as KeyUsage[]);
  }
}

export function formatReport(r: UsageReport): string[] {
  return [
    `Usage report ${r.from} to ${r.to} (UTC, inclusive)`,
    `Unique active keys: ${r.uniqueActiveKeys}`,
    `Total successful checks: ${r.totalSuccessfulChecks}`,
    `Repeat keys (active on 2 or more distinct days): ${r.repeatKeys}`,
  ];
}

/**
 * The report's data source: `--usage-file` when given, otherwise the Upstash store named by
 * UPSTASH_REDIS_REST_URL/TOKEN or KV_REST_API_URL/TOKEN (D-1). Read-only: it only lists usage.
 */
export function loadUsageSource(
  usageFile: string | undefined,
  env: Record<string, string | undefined>,
  fetchImpl?: typeof fetch,
): Pick<Store, "listUsage"> {
  if (usageFile) return new UsageFileStore(usageFile);
  const config = upstashConfigFromEnv(env);
  if (!config) {
    throw new Error(
      "No usage source: pass --usage-file usage.json, or set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (or KV_REST_API_URL and KV_REST_API_TOKEN).",
    );
  }
  return new UpstashStore(config, fetchImpl);
}

export async function main(
  argv: string[],
  write: (line: string) => void = console.log,
  env: Record<string, string | undefined> = process.env,
  fetchImpl?: typeof fetch,
): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      from: { type: "string" },
      to: { type: "string" },
      "usage-file": { type: "string" },
    },
  });
  if (!values.from || !values.to) {
    throw new Error(
      "Usage: usage-report --from YYYY-MM-DD --to YYYY-MM-DD [--usage-file usage.json]",
    );
  }
  const report = await buildUsageReport(
    loadUsageSource(values["usage-file"], env, fetchImpl),
    values.from,
    values.to,
  );
  for (const line of formatReport(report)) write(line);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
