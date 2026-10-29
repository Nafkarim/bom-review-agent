import { describe, expect, it } from "vitest";
import { DEMOS } from "../src/demo";
import { IntakeError, parseCsv, parseReviewInput } from "../src/parse";
import {
  finalizeFindings,
  runRules,
  verdict,
  type Judgment
} from "../src/rules";
import type { Finding, ReviewInput } from "../src/types";

const MODEL = "test-model";

function review(input: ReviewInput, judgments: Judgment[] = []): Finding[] {
  const result = runRules(input);
  return finalizeFindings(
    input,
    result,
    new Map(judgments.map((j) => [j.line, j]))
  );
}

const find = (fs: Finding[], category: string, partNumber: string) =>
  fs.filter((f) => f.category === category && f.partNumber === partNumber);

describe("demo BOM with planted issues", () => {
  const input = parseReviewInput(DEMOS.issues);
  const xcvrLine = input.bom.find(
    (l) => l.partNumber === "VO-Q28-SR4-100"
  )!.line;
  const lightLine = input.bom.find(
    (l) => l.partNumber === "RK-LIGHT-LED"
  )!.line;
  const judgments: Judgment[] = [
    {
      line: xcvrLine,
      substituteFor: "RK-XCVR-100G-SR4",
      risk: "medium",
      rationale: "Same form factor.",
      modelId: MODEL
    },
    {
      line: lightLine,
      substituteFor: null,
      risk: "low",
      rationale: "Accessory, not a spec part.",
      modelId: MODEL
    }
  ];
  const findings = review(input, judgments);

  it("sends only the two off-spec lines to the LLM", () => {
    const { unresolved } = runRules(input);
    expect(unresolved.map((u) => u.line.partNumber).sort()).toEqual([
      "RK-LIGHT-LED",
      "VO-Q28-SR4-100"
    ]);
    expect(unresolved[0].candidates.map((c) => c.partNumber)).toEqual([
      "RK-XCVR-100G-SR4"
    ]);
  });

  it("1. flags the PDU on the wrong revision", () => {
    const [f] = find(findings, "revision-mismatch", "RK-PDU-30A-3P");
    expect(f).toMatchObject({
      severity: "blocker",
      expected: "rev D",
      found: "rev C",
      line: 2
    });
  });

  it("2. flags the transceiver substitution from another vendor", () => {
    const [f] = find(findings, "substitution", "VO-Q28-SR4-100");
    expect(f).toMatchObject({
      severity: "needs-review",
      source: "llm",
      modelId: MODEL,
      line: xcvrLine
    });
    // The substitute covers the required quantity, so no missing-part finding.
    expect(find(findings, "quantity", "RK-XCVR-100G-SR4")).toHaveLength(0);
  });

  it("3. flags the power-cable quantity shortfall", () => {
    const [f] = find(findings, "quantity", "RK-CBL-PWR-C19");
    expect(f).toMatchObject({
      severity: "blocker",
      expected: "36 per rack",
      found: "32"
    });
  });

  it("4. flags the cert tied to an old drawing revision", () => {
    const [f] = find(findings, "cert", "RK-SW-TOR-100G");
    expect(f).toMatchObject({ severity: "blocker", expected: "drawing rev C" });
  });

  it("5. flags the SSD lead time past need-by", () => {
    const [f] = find(findings, "lead-time", "RK-SSD-3T84");
    expect(f.severity).toBe("blocker");
    expect(f.found).toBe("75 days, arrives 2027-01-11");
  });

  it("6. flags the part that is not in the spec", () => {
    const [f] = find(findings, "not-in-spec", "RK-LIGHT-LED");
    expect(f).toMatchObject({
      severity: "blocker",
      source: "llm",
      line: lightLine
    });
  });

  it("records the approved DAC substitute as info and counts it toward quantity", () => {
    expect(find(findings, "substitution", "RK-DAC-100G-2M-S")[0].severity).toBe(
      "info"
    );
    expect(find(findings, "quantity", "RK-DAC-100G-2M")).toHaveLength(0);
  });

  it("sums split DIMM lines", () => {
    expect(find(findings, "quantity", "RK-DIMM-64G")).toHaveLength(0);
  });

  it("produces exactly the planted findings plus two info notes, and holds the build", () => {
    const summary = findings.map(
      (f) => `${f.severity}:${f.category}:${f.partNumber}`
    );
    expect(summary).toEqual([
      "blocker:revision-mismatch:RK-PDU-30A-3P",
      "blocker:lead-time:RK-SSD-3T84",
      "blocker:cert:RK-SW-TOR-100G",
      "blocker:quantity:RK-CBL-PWR-C19",
      "blocker:not-in-spec:RK-LIGHT-LED",
      "needs-review:substitution:VO-Q28-SR4-100",
      "info:substitution:RK-DAC-100G-2M-S",
      "info:power:(rack)"
    ]);
    expect(findings.map((f) => f.id)).toEqual([
      "F-01",
      "F-02",
      "F-03",
      "F-04",
      "F-05",
      "F-06",
      "F-07",
      "F-08"
    ]);
    expect(verdict(findings)).toBe("hold");
  });

  it("escalates a high-risk substitution to a blocker", () => {
    const fs = review(input, [{ ...judgments[0], risk: "high" }, judgments[1]]);
    expect(find(fs, "substitution", "VO-Q28-SR4-100")[0].severity).toBe(
      "blocker"
    );
  });

  it("still works when the model is unavailable: off-spec lines go to a human, missing part is a blocker", () => {
    const fs = review(input, []);
    expect(find(fs, "not-in-spec", "VO-Q28-SR4-100")[0]).toMatchObject({
      severity: "needs-review",
      source: "rule"
    });
    expect(find(fs, "quantity", "RK-XCVR-100G-SR4")[0]).toMatchObject({
      severity: "blocker",
      found: "not on BOM"
    });
    expect(fs.every((f) => f.source === "rule")).toBe(true);
  });

  it("ignores a judgment naming a part that was not a candidate", () => {
    const fs = review(input, [
      { ...judgments[0], substituteFor: "RK-SRV-2U-G5" },
      judgments[1]
    ]);
    expect(find(fs, "not-in-spec", "VO-Q28-SR4-100")).toHaveLength(1);
  });
});

describe("clean demo BOM", () => {
  const input = parseReviewInput(DEMOS.clean);

  it("needs no LLM call and is ready to build", () => {
    expect(runRules(input).unresolved).toHaveLength(0);
    const findings = review(input);
    expect(findings.filter((f) => f.severity !== "info")).toHaveLength(0);
    expect(verdict(findings)).toBe("ready");
  });

  it("reports power near budget as info", () => {
    const [f] = review(input).filter((f) => f.category === "power");
    expect(f).toMatchObject({
      severity: "info",
      found: "15875 W (93% of budget)"
    });
  });
});

describe("edge cases", () => {
  const base = parseReviewInput(DEMOS.clean);
  const clone = (): ReviewInput => structuredClone(base);

  it("blocks when power exceeds the budget", () => {
    const input = clone();
    input.spec.powerBudgetW = 15000;
    const [f] = review(input).filter((f) => f.category === "power");
    expect(f.severity).toBe("blocker");
    expect(verdict(review(input))).toBe("hold");
  });

  it("has no power finding at or below the warning ratio", () => {
    const input = clone();
    input.spec.powerBudgetW = 17639; // 15875 W is 89.99% of this
    expect(review(input).filter((f) => f.category === "power")).toHaveLength(0);
  });

  it("treats arrival exactly on need-by as on time, one day later as late", () => {
    const input = clone();
    const line = input.bom[0];
    line.leadTimeDays = 48; // 2026-10-28 + 48 = 2026-12-15
    expect(
      review(input).filter((f) => f.category === "lead-time")
    ).toHaveLength(0);
    line.leadTimeDays = 49;
    expect(
      review(input).filter((f) => f.category === "lead-time")
    ).toHaveLength(1);
  });

  it("flags blank lead time and missing cert as needs-review", () => {
    const input = clone();
    input.bom[0].leadTimeDays = null;
    input.bom[1].certRef = "FAI-DOES-NOT-EXIST";
    const fs = review(input).filter((f) => f.category === "missing-data");
    expect(fs.map((f) => f.line)).toEqual([1, 2]);
    expect(fs.every((f) => f.severity === "needs-review")).toBe(true);
  });

  it("flags an unapproved manufacturer on a spec part number", () => {
    const input = clone();
    input.bom[0].manufacturer = "Unknown Metalworks";
    expect(review(input).find((f) => f.category === "vendor")?.severity).toBe(
      "blocker"
    );
  });

  it("flags extra quantity as needs-review", () => {
    const input = clone();
    input.bom[0].quantity = 2;
    expect(review(input).find((f) => f.category === "quantity")?.severity).toBe(
      "needs-review"
    );
  });

  it("a reviewer rejecting the only blocker makes the build ready", () => {
    const input = clone();
    input.bom[0].revision = "Z";
    const fs = review(input);
    expect(verdict(fs)).toBe("hold");
    expect(
      verdict(
        fs.map((f) =>
          f.severity === "blocker" ? { ...f, status: "rejected" } : f
        )
      )
    ).toBe("ready");
  });
});

describe("intake", () => {
  it("parses quoted CSV fields", () => {
    expect(parseCsv('a,b\n1,"x, ""y"""\r\n')).toEqual([
      ["a", "b"],
      ["1", 'x, "y"']
    ]);
  });

  it("lists every problem in one error", () => {
    const bad = {
      ...DEMOS.clean,
      bom: "line,part_number\n1,X\n",
      context: "{"
    };
    try {
      parseReviewInput(bad);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(IntakeError);
      const problems = (e as IntakeError).problems.join("\n");
      expect(problems).toContain("context.json: not valid JSON");
      expect(problems).toContain("bom.csv: missing column(s)");
    }
  });

  it("rejects a context whose spec revision does not match", () => {
    const ctx = JSON.parse(DEMOS.clean.context);
    expect(() =>
      parseReviewInput({
        ...DEMOS.clean,
        context: JSON.stringify({ ...ctx, specRevision: "B" })
      })
    ).toThrow(/does not match/);
  });
});
