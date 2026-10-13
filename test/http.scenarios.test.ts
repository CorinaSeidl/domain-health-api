import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadVectors } from "./harness/vectors.js";

describe("http.json completeness", () => {
  const dir = new URL("./", import.meta.url);
  const sources = readdirSync(dir)
    .filter(
      (f) => /^http\..+\.test\.ts$/.test(f) && f !== "http.scenarios.test.ts",
    )
    .map((f) => readFileSync(new URL(f, dir), "utf8"))
    .join("\n");

  for (const v of loadVectors("http.json")) {
    it(`${v.id} has a test named with its id`, () => {
      const real = new RegExp(`scenario\\(\\s*"${v.id}"`);
      const todo = new RegExp(`scenario\\.todo\\(\\s*"${v.id}"`);
      expect(real.test(sources) || todo.test(sources)).toBe(true);
    });
  }

  it("only the M3 scenarios are placeholders, and a placeholder is not coverage", () => {
    const todos = [...sources.matchAll(/scenario\.todo\(\s*"(H-\d+)"/g)].map(
      (m) => m[1],
    );
    expect(todos.sort()).toEqual(["H-17", "H-31"]);
  });
});
