import { describe, expect, it } from "vitest";
import { DEMOS } from "../src/demo";
import { parseReviewInput } from "../src/parse";
import { finalizeFindings, runRules, verdict } from "../src/rules";
import {
  currentSpec,
  diffSpecs,
  nextRevision,
  saveSpec,
  summarize,
  type SpecLibraryState
} from "../src/spec-library";
import type { Spec } from "../src/types";

const demoSpec: Spec = JSON.parse(DEMOS.issues.spec);
const empty: SpecLibraryState = { specs: {} };

function seeded(): SpecLibraryState {
  const res = saveSpec(empty, demoSpec, "seed");
  if (!res.ok) throw new Error(res.problems.join("; "));
  return res.state;
}

const edit = (fn: (s: Spec) => void): Spec => {
  const s = structuredClone(demoSpec);
  fn(s);
  return s;
};

describe("saveSpec", () => {
  it("creates a new spec and lists it", () => {
    const state = seeded();
    expect(summarize(state)).toEqual([
      expect.objectContaining({
        specId: "RS-COMPUTE-48U",
        revision: "C",
        partCount: 36,
        revisions: 1
      })
    ]);
  });

  it("refuses a change without a new revision label", () => {
    const res = saveSpec(
      seeded(),
      edit((s) => (s.powerBudgetW = 18000)),
      ""
    );
    expect(res).toEqual({
      ok: false,
      problems: [expect.stringMatching(/new revision label.*rev C/)]
    });
  });

  it("refuses saving with no changes, and reusing an old revision label", () => {
    const state = seeded();
    expect(saveSpec(state, demoSpec, "")).toEqual({
      ok: false,
      problems: ["No changes to save."]
    });
    const d = saveSpec(
      state,
      edit((s) => (s.revision = "D")),
      ""
    );
    if (!d.ok) throw new Error("expected save");
    const back = saveSpec(
      d.state,
      edit((s) => ((s.revision = "C"), (s.powerBudgetW = 1))),
      ""
    );
    expect(back).toEqual({
      ok: false,
      problems: [expect.stringMatching(/already used/)]
    });
  });

  it("saves a new revision, keeps history, and records what changed", () => {
    const next = edit((s) => {
      s.revision = "D";
      s.powerBudgetW = 18000;
      s.parts.find((p) => p.partNumber === "RK-PDU-30A-3P")!.revision = "E";
      s.parts = s.parts.filter((p) => p.partNumber !== "RK-DOC-PACK");
      s.parts.push({
        ...s.parts[0],
        partNumber: "RK-NEW-1",
        description: "New bracket"
      });
    });
    const res = saveSpec(seeded(), next, "ECO-114: new PDU rev");
    if (!res.ok) throw new Error(res.problems.join("; "));
    expect(res.state.specs["RS-COMPUTE-48U"]).toHaveLength(2);
    expect(currentSpec(res.state, "RS-COMPUTE-48U")?.revision).toBe("D");
    expect(res.record.note).toBe("ECO-114: new PDU rev");
    expect(res.record.changes).toEqual([
      "Revision C → D",
      "Power budget 17000 W → 18000 W",
      "RK-PDU-30A-3P: rev D → E",
      "Added RK-NEW-1 (New bracket, qty 1, rev B)",
      "Removed RK-DOC-PACK"
    ]);
  });

  it("validates like an uploaded spec: blank fields, bad ids, duplicate part numbers", () => {
    const res = saveSpec(
      empty,
      edit((s) => {
        s.specId = "bad id!";
        s.parts[1].partNumber = s.parts[0].partNumber;
        s.parts[2].approvedManufacturers = [" "];
      }),
      ""
    );
    expect(res.ok).toBe(false);
    const problems = (res as { problems: string[] }).problems.join("\n");
    expect(problems).toContain("specId: letters, digits and dashes only");
    expect(problems).toContain("listed more than once");
    expect(problems).toContain("must not be blank");
  });

  it("supports a second rack design alongside the first", () => {
    const storage = edit((s) => {
      s.specId = "RS-STORAGE-42U";
      s.revision = "A";
      s.rackName = "42U storage rack";
      s.parts = s.parts.slice(0, 5);
    });
    const res = saveSpec(seeded(), storage, "");
    if (!res.ok) throw new Error(res.problems.join("; "));
    expect(
      summarize(res.state).map((s) => `${s.specId} rev ${s.revision}`)
    ).toEqual(["RS-COMPUTE-48U rev C", "RS-STORAGE-42U rev A"]);
  });
});

describe("diffSpecs and nextRevision", () => {
  it("describes manufacturer and substitute changes", () => {
    const next = edit((s) => {
      const dac = s.parts.find((p) => p.partNumber === "RK-DAC-100G-2M")!;
      dac.approvedManufacturers.push("Summit Networks");
      dac.approvedSubstitutes = [];
    });
    expect(diffSpecs(demoSpec, next)).toEqual([
      "RK-DAC-100G-2M: manufacturers Keystone Cable → Keystone Cable, Summit Networks; substitutes RK-DAC-100G-2M-S/Summit Networks/rev A → (none)"
    ]);
  });

  it("suggests the next label", () => {
    expect(nextRevision("C")).toBe("D");
    expect(nextRevision("1.2")).toBe("1.3");
    expect(nextRevision("v9")).toBe("v10");
    expect(nextRevision("Z")).toBe("Z-1");
  });
});

describe("reviews against an updated spec", () => {
  it("flags a BOM prepared against an older revision as a blocker", () => {
    const input = parseReviewInput({
      ...DEMOS.clean,
      spec: JSON.stringify(edit((s) => (s.revision = "D")))
    });
    const findings = finalizeFindings(input, runRules(input), new Map());
    expect(findings[0]).toMatchObject({
      category: "spec-revision",
      severity: "blocker",
      found: "prepared against rev C"
    });
    expect(verdict(findings)).toBe("hold");
  });

  it("applies the new spec values to the BOM", () => {
    // Raising the cable count in the spec makes the clean BOM short.
    const spec = edit(
      (s) =>
        (s.parts.find((p) => p.partNumber === "RK-CBL-PWR-C19")!.qtyPerRack =
          40)
    );
    const input = parseReviewInput({
      ...DEMOS.clean,
      spec: JSON.stringify(spec)
    });
    const findings = finalizeFindings(input, runRules(input), new Map());
    expect(findings.find((f) => f.category === "quantity")).toMatchObject({
      partNumber: "RK-CBL-PWR-C19",
      expected: "40 per rack",
      found: "36"
    });
  });
});
