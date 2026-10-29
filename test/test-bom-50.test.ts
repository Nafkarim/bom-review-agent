// Checks the generated 50-line BOM (scripts/make-test-bom.mjs) against its answer key.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseReviewInput } from "../src/parse";
import {
  finalizeFindings,
  runRules,
  verdict,
  type Judgment
} from "../src/rules";

const dir = "demo/test-bom-50";
const read = (f: string) => readFileSync(`${dir}/${f}`, "utf8");

type KeyIssue = {
  lines: number[];
  partNumber: string;
  substituteFor?: string;
  category: string;
  source: "rule" | "llm";
};
const key: { lines: number; issues: KeyIssue[] } = JSON.parse(
  read("answer-key.json")
);

const input = parseReviewInput({
  spec: read("spec.json"),
  bom: read("bom.csv"),
  certs: read("certs.csv"),
  context: read("context.json")
});

// Stand in for the LLM with the answer the key expects.
const judgments: Judgment[] = key.issues
  .filter((i) => i.source === "llm")
  .flatMap((i) =>
    i.lines.map((line) => ({
      line,
      substituteFor: i.substituteFor ?? null,
      risk: "medium" as const,
      rationale: "test",
      modelId: "test-model"
    }))
  );

describe("generated 50-line test BOM", () => {
  const findings = finalizeFindings(
    input,
    runRules(input),
    new Map(judgments.map((j) => [j.line, j]))
  );
  const planted = findings.filter((f) => f.severity !== "info");

  it("has 50 lines and 8 planted issues", () => {
    expect(input.bom).toHaveLength(50);
    expect(key.lines).toBe(50);
    expect(key.issues).toHaveLength(8);
  });

  it("finds every planted issue, on the right line, and nothing else", () => {
    // The key lists every line a finding lands on: a cert or substitution spread
    // across split lines is flagged per line, a quantity shortfall on the first line.
    const expected = key.issues.flatMap((i) =>
      i.lines.map((line) => `${i.category}:${i.partNumber}:${line}`)
    );
    const actual = planted.map(
      (f) => `${f.category}:${f.partNumber}:${f.line}`
    );
    expect(actual.sort()).toEqual(expected.sort());
  });

  it("only adds rack power as info, and holds the build", () => {
    expect(
      findings.filter((f) => f.severity === "info").map((f) => f.category)
    ).toEqual(["power"]);
    expect(verdict(findings)).toBe("hold");
  });
});
