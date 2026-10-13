import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import type { KeyUsage, Store } from "../src/http/store/types.js";

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
 * Read-only Store over a JSON dump of `listUsage()` (an array of `{ keyId, counts }`). The
 * durable store (DECISIONS.md D-1) arrives in M4; until then this is the report's data source.
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

export async function main(
  argv: string[],
  write: (line: string) => void = console.log,
): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      from: { type: "string" },
      to: { type: "string" },
      "usage-file": { type: "string" },
    },
  });
  if (!values.from || !values.to || !values["usage-file"]) {
    throw new Error(
      "Usage: usage-report --from YYYY-MM-DD --to YYYY-MM-DD --usage-file usage.json",
    );
  }
  const report = await buildUsageReport(
    new UsageFileStore(values["usage-file"]),
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
