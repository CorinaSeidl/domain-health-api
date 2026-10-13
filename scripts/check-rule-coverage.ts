import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Acceptance #2 (SPEC.md §12): every rule ID except the §11 KEY-* rules must be tested. */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const RULE_ROW = /^\|\s*\*\*([A-Z]+-\d+)\*\*\s*\|/gm;
const EXCLUDED = /^KEY-/;
const TODO_CALL = /\b(?:scenario|it|test)(?:\.[a-zA-Z]+)*\.todo\s*\(/g;

/** Rule IDs defined in SPEC.md tables (bold first cell), minus the §11 KEY-* rules. */
export function extractRuleIds(spec: string): string[] {
  const ids = [...spec.matchAll(RULE_ROW)].map((m) => m[1]!);
  return [...new Set(ids)].filter((id) => !EXCLUDED.test(id));
}

/** Index just past the `)` that closes the call whose `(` is at `open`; string-aware. */
function endOfCall(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === "\\") i++;
    } else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i + 1;
  }
  return src.length;
}

/** Removes `it.todo(...)`, `scenario.todo(...)` and `test.todo(...)` calls: a placeholder is not coverage. */
export function stripTodos(src: string): string {
  let out = "";
  let last = 0;
  for (const m of src.matchAll(TODO_CALL)) {
    if (m.index < last) continue;
    out += src.slice(last, m.index);
    last = endOfCall(src, m.index + m[0].length - 1);
  }
  return out + src.slice(last);
}

/** True when `id` appears as a whole rule ID (SPF-1 must not match inside SPF-16 or XSPF-1). */
export function mentions(text: string, id: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9-])${id}(?![0-9])`).test(text);
}

export interface VectorFile {
  name: string;
  vectors: { id: string; rules: string[] }[];
}

export interface CoverageInput {
  spec: string;
  /** Contents of every test file under test/. */
  tests: string[];
  vectorFiles: VectorFile[];
}

/**
 * A rule is covered when a test names it (todo placeholders removed) or a vector lists it.
 * http.json holds prose scenarios that only count once a real `scenario("H-n", ...)` test
 * exists, so a rule listed only by a placeholder scenario stays uncovered.
 */
export function findUncovered(input: CoverageInput): {
  total: number;
  uncovered: string[];
} {
  const ids = extractRuleIds(input.spec);
  const tests = input.tests.map(stripTodos);
  const joined = tests.join("\n");
  const covered = new Set<string>();
  for (const file of input.vectorFiles) {
    for (const v of file.vectors) {
      const live =
        file.name !== "http.json" ||
        new RegExp(`scenario\\(\\s*"${v.id}"`).test(joined);
      if (live) for (const rule of v.rules) covered.add(rule);
    }
  }
  return {
    total: ids.length,
    uncovered: ids.filter((id) => !covered.has(id) && !mentions(joined, id)),
  };
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
}

export function loadInput(root: string): CoverageInput {
  const vectorDir = join(root, "spec", "vectors");
  return {
    spec: readFileSync(join(root, "spec", "SPEC.md"), "utf8"),
    tests: walk(join(root, "test"))
      .filter((f) => f.endsWith(".ts"))
      .map((f) => readFileSync(f, "utf8")),
    vectorFiles: readdirSync(vectorDir)
      .filter((f) => f.endsWith(".json"))
      .map((name) => ({
        name,
        vectors: (
          JSON.parse(readFileSync(join(vectorDir, name), "utf8")) as {
            vectors: VectorFile["vectors"];
          }
        ).vectors,
      })),
  };
}

export function main(root: string = ROOT): number {
  const { total, uncovered } = findUncovered(loadInput(root));
  if (uncovered.length > 0) {
    console.error(
      `Rule coverage FAILED: ${uncovered.length} of ${total} rule IDs have no test:`,
    );
    for (const id of uncovered) console.error(`  ${id}`);
    return 1;
  }
  console.log(
    `Rule coverage OK: all ${total} rule IDs are tested (KEY-* excluded).`,
  );
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exit(main());
}
