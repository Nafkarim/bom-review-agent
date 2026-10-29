// Deterministic checks. No LLM here: revision, quantity, vendor, cert, lead time
// and power are exact comparisons, so plain code does them.
import type {
  BomLine,
  Finding,
  ReviewInput,
  Severity,
  SpecPart,
  Verdict
} from "./types";

/** Share of the power budget above which an info finding is raised. */
export const POWER_WARN_RATIO = 0.9;

type Draft = Omit<Finding, "id" | "status">;

/** A BOM line the rules cannot place: not a spec part or approved substitute. */
export type UnresolvedLine = {
  line: BomLine;
  /** Spec parts with no coverage in the BOM; the line may be replacing one of them. */
  candidates: SpecPart[];
};

/** The LLM's verdict on one unresolved line (validated before it gets here). */
export type Judgment = {
  line: number;
  substituteFor: string | null;
  risk: "low" | "medium" | "high";
  rationale: string;
  modelId: string;
};

export type RuleResult = {
  findings: Draft[];
  unresolved: UnresolvedLine[];
  /** Quantity on the BOM that counts toward each spec part number. */
  coverage: Map<string, number>;
  /** Lines counted toward each spec part (first one is cited in findings). */
  linesFor: Map<string, number[]>;
};

const SEVERITY_RANK: Record<Severity, number> = {
  blocker: 0,
  "needs-review": 1,
  info: 2
};

function addDays(isoDate: string, days: number): Date {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

const toIso = (d: Date) => d.toISOString().slice(0, 10);
const daysBetween = (a: Date, b: Date) =>
  Math.round((b.getTime() - a.getTime()) / 86_400_000);

export function runRules(input: ReviewInput): RuleResult {
  const { spec, bom, certs, context } = input;
  const findings: Draft[] = [];
  const partsByPn = new Map(spec.parts.map((p) => [p.partNumber, p]));
  const subsByPn = new Map(
    spec.parts.flatMap((p) =>
      p.approvedSubstitutes.map(
        (s) => [s.partNumber, { parent: p, sub: s }] as const
      )
    )
  );
  const certsByRef = new Map(certs.map((c) => [c.certRef, c]));
  const coverage = new Map<string, number>();
  const linesFor = new Map<string, number[]>();
  const unmatched: BomLine[] = [];
  const needBy = new Date(`${context.needBy}T00:00:00Z`);

  if (context.specRevision !== spec.revision) {
    findings.push({
      line: null,
      partNumber: "(spec)",
      category: "spec-revision",
      severity: "blocker",
      expected: `BOM prepared against ${spec.specId} rev ${spec.revision}`,
      found: `prepared against rev ${context.specRevision}`,
      evidence: `The spec changed after the ODM built this BOM; line findings below are checked against rev ${spec.revision}.`,
      suggestedAction: `Ask the ODM to resubmit against rev ${spec.revision}, or confirm the changes between revisions do not affect this build.`,
      source: "rule"
    });
  }

  const count = (pn: string, line: BomLine) => {
    coverage.set(pn, (coverage.get(pn) ?? 0) + line.quantity);
    linesFor.set(pn, [...(linesFor.get(pn) ?? []), line.line]);
  };

  for (const line of bom) {
    const base = {
      line: line.line,
      partNumber: line.partNumber,
      source: "rule" as const
    };
    const part = partsByPn.get(line.partNumber);
    const approvedSub = subsByPn.get(line.partNumber);
    let expectedRevision: string | null = null;

    if (part) {
      expectedRevision = part.revision;
      count(part.partNumber, line);
      if (!part.approvedManufacturers.includes(line.manufacturer)) {
        findings.push({
          ...base,
          category: "vendor",
          severity: "blocker",
          expected: part.approvedManufacturers.join(" or "),
          found: line.manufacturer || "(blank)",
          evidence: `Spec ${spec.specId} rev ${spec.revision} lists ${part.partNumber} from ${part.approvedManufacturers.join(", ")} only.`,
          suggestedAction:
            "Source from an approved manufacturer or request an approved-vendor-list update."
        });
      }
    } else if (approvedSub) {
      expectedRevision = approvedSub.sub.revision;
      count(approvedSub.parent.partNumber, line);
      findings.push({
        ...base,
        category: "substitution",
        severity: "info",
        expected: approvedSub.parent.partNumber,
        found: `${line.partNumber} (${line.manufacturer})`,
        evidence: `${line.partNumber} is an approved substitute for ${approvedSub.parent.partNumber} in spec rev ${spec.revision}.`,
        suggestedAction: "No action; recorded for traceability."
      });
    } else {
      unmatched.push(line);
    }

    if (expectedRevision !== null && line.revision !== expectedRevision) {
      findings.push({
        ...base,
        category: "revision-mismatch",
        severity: "blocker",
        expected: `rev ${expectedRevision}`,
        found: line.revision ? `rev ${line.revision}` : "(blank)",
        evidence: `Spec ${spec.specId} rev ${spec.revision} requires ${line.partNumber} at rev ${expectedRevision}.`,
        suggestedAction: `Supply ${line.partNumber} at rev ${expectedRevision}, or submit a deviation request.`
      });
    }

    if (line.leadTimeDays === null) {
      findings.push({
        ...base,
        category: "missing-data",
        severity: "needs-review",
        expected: "lead time in days",
        found: "(blank)",
        evidence:
          "Lead time is required to confirm the part arrives by the need-by date.",
        suggestedAction: "Ask the ODM for a committed lead time."
      });
    } else {
      const arrives = addDays(context.asOf, line.leadTimeDays);
      if (arrives > needBy) {
        findings.push({
          ...base,
          category: "lead-time",
          severity: "blocker",
          expected: `on site by ${context.needBy}`,
          found: `${line.leadTimeDays} days, arrives ${toIso(arrives)}`,
          evidence: `Ordered ${context.asOf} + ${line.leadTimeDays} days lands ${daysBetween(needBy, arrives)} days after need-by.`,
          suggestedAction:
            "Expedite, find stock from an approved substitute, or move the need-by date."
        });
      }
    }

    // Cert checks only apply where we know the expected drawing revision.
    if (expectedRevision !== null) {
      if (!line.certRef) {
        findings.push({
          ...base,
          category: "missing-data",
          severity: "needs-review",
          expected: "cert reference",
          found: "(blank)",
          evidence: "Every BOM line needs an FAI/cert reference.",
          suggestedAction: "Request the first-article cert from the ODM."
        });
      } else {
        const cert = certsByRef.get(line.certRef);
        if (!cert) {
          findings.push({
            ...base,
            category: "missing-data",
            severity: "needs-review",
            expected: `cert ${line.certRef} in cert list`,
            found: "not found",
            evidence: `Cert ${line.certRef} is referenced by the BOM but missing from the cert package.`,
            suggestedAction: "Request the missing cert."
          });
        } else if (cert.partNumber !== line.partNumber) {
          findings.push({
            ...base,
            category: "cert",
            severity: "blocker",
            expected: `cert for ${line.partNumber}`,
            found: `cert ${cert.certRef} is for ${cert.partNumber}`,
            evidence: "The referenced cert covers a different part.",
            suggestedAction: "Request the correct cert for this part."
          });
        } else if (cert.drawingRevision !== expectedRevision) {
          findings.push({
            ...base,
            category: "cert",
            severity: "blocker",
            expected: `drawing rev ${expectedRevision}`,
            found: `${cert.certRef} references rev ${cert.drawingRevision} (issued ${cert.issued})`,
            evidence:
              "The first-article cert was issued against an older drawing revision.",
            suggestedAction: `Re-run first-article inspection against rev ${expectedRevision} and resubmit the cert.`
          });
        }
      }
    }
  }

  const uncovered = spec.parts.filter((p) => !coverage.has(p.partNumber));
  const unresolved: UnresolvedLine[] = [];
  for (const line of unmatched) {
    if (uncovered.length === 0) {
      findings.push(
        notInSpec(
          line,
          "No required part is missing, so this line cannot be a substitute.",
          "rule"
        )
      );
    } else {
      unresolved.push({ line, candidates: uncovered });
    }
  }
  return { findings, unresolved, coverage, linesFor };
}

function notInSpec(
  line: BomLine,
  evidence: string,
  source: "rule" | "llm",
  modelId?: string
): Draft {
  return {
    line: line.line,
    partNumber: line.partNumber,
    category: "not-in-spec",
    severity: "blocker",
    expected: "a part from the spec or approved-substitute list",
    found: `${line.partNumber}: ${line.description} (${line.manufacturer})`,
    evidence,
    suggestedAction:
      "Remove the line, or request a spec change if the part is needed.",
    source,
    ...(modelId ? { modelId } : {})
  };
}

/**
 * Combines rule findings with LLM judgments, then runs the checks that need the
 * full picture: required-part quantities and the rack power budget.
 * A missing judgment means the model was unavailable; the line goes to a human.
 */
export function finalizeFindings(
  input: ReviewInput,
  result: RuleResult,
  judgments: Map<number, Judgment>
): Finding[] {
  const { spec } = input;
  const findings = [...result.findings];
  const coverage = new Map(result.coverage);
  const linesFor = new Map(result.linesFor);
  const partsByPn = new Map(spec.parts.map((p) => [p.partNumber, p]));

  for (const { line, candidates } of result.unresolved) {
    const j = judgments.get(line.line);
    const target = j?.substituteFor
      ? candidates.find((c) => c.partNumber === j.substituteFor)
      : undefined;
    if (!j) {
      findings.push({
        ...notInSpec(
          line,
          `Not in the spec, and the model was unavailable to judge whether it replaces ${candidates.map((c) => c.partNumber).join(", ")}.`,
          "rule"
        ),
        severity: "needs-review",
        suggestedAction:
          "Reviewer: decide whether this is a substitution or an extra part."
      });
    } else if (target) {
      coverage.set(
        target.partNumber,
        (coverage.get(target.partNumber) ?? 0) + line.quantity
      );
      linesFor.set(target.partNumber, [
        ...(linesFor.get(target.partNumber) ?? []),
        line.line
      ]);
      findings.push({
        line: line.line,
        partNumber: line.partNumber,
        category: "substitution",
        severity: j.risk === "high" ? "blocker" : "needs-review",
        expected: `${target.partNumber} (${target.approvedManufacturers.join(", ")})`,
        found: `${line.partNumber} (${line.manufacturer})`,
        evidence: `Unapproved substitute, ${j.risk} risk. ${j.rationale}`,
        suggestedAction: `Supply ${target.partNumber}, or submit ${line.partNumber} for qualification and AVL approval.`,
        source: "llm",
        modelId: j.modelId
      });
    } else {
      findings.push(notInSpec(line, j.rationale, "llm", j.modelId));
    }
  }

  for (const part of spec.parts) {
    const have = coverage.get(part.partNumber) ?? 0;
    const lines = linesFor.get(part.partNumber) ?? [];
    if (have === part.qtyPerRack) continue;
    findings.push({
      line: lines[0] ?? null,
      partNumber: part.partNumber,
      category: "quantity",
      severity: have < part.qtyPerRack ? "blocker" : "needs-review",
      expected: `${part.qtyPerRack} per rack`,
      found:
        have === 0
          ? "not on BOM"
          : `${have}${lines.length > 1 ? ` across lines ${lines.join(", ")}` : ""}`,
      evidence:
        have === 0
          ? `${part.partNumber} (${part.description}) is required by spec rev ${spec.revision} but no BOM line supplies it.`
          : `Spec rev ${spec.revision} requires ${part.qtyPerRack}; BOM ${have < part.qtyPerRack ? "is short" : "has extra"} by ${Math.abs(part.qtyPerRack - have)}.`,
      suggestedAction:
        have < part.qtyPerRack
          ? `Add ${part.qtyPerRack - have} x ${part.partNumber}.`
          : "Confirm the extra quantity is intentional (spares) or remove it.",
      source: "rule"
    });
  }

  findings.push(...powerFindings(input, coverage, partsByPn));
  return assignIds(findings);
}

function powerFindings(
  input: ReviewInput,
  coverage: Map<string, number>,
  partsByPn: Map<string, SpecPart>
): Draft[] {
  const { spec } = input;
  let total = 0;
  for (const [pn, qty] of coverage)
    total += (partsByPn.get(pn)?.wattsEach ?? 0) * qty;
  total = Math.round(total);
  const ratio = total / spec.powerBudgetW;
  if (ratio <= POWER_WARN_RATIO) return [];
  const pct = Math.round(ratio * 100);
  const over = ratio > 1;
  return [
    {
      line: null,
      partNumber: "(rack)",
      category: "power",
      severity: over ? "blocker" : "info",
      expected: `<= ${spec.powerBudgetW} W`,
      found: `${total} W (${pct}% of budget)`,
      evidence:
        "Sum of quantity x rated watts for every spec part on the BOM, substitutes counted at the watts of the part they replace.",
      suggestedAction: over
        ? "Reduce node count or get a higher rack power allocation before build."
        : "Within budget; note limited headroom for future upgrades.",
      source: "rule"
    }
  ];
}

function assignIds(drafts: Draft[]): Finding[] {
  return drafts
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
        (a.line ?? Number.MAX_SAFE_INTEGER) -
          (b.line ?? Number.MAX_SAFE_INTEGER)
    )
    .map((d, i) => ({
      ...d,
      id: `F-${String(i + 1).padStart(2, "0")}`,
      status: "pending"
    }));
}

/** Hold if any blocker the reviewer has not rejected. */
export function verdict(findings: Finding[]): Verdict {
  return findings.some(
    (f) => f.severity === "blocker" && f.status !== "rejected"
  )
    ? "hold"
    : "ready";
}

export function severityCounts(findings: Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = {
    blocker: 0,
    "needs-review": 0,
    info: 0
  };
  for (const f of findings) if (f.status !== "rejected") counts[f.severity]++;
  return counts;
}
