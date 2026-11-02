// Rack spec library: the "gold standard" each BOM is reviewed against.
// Pure functions (no I/O) so the save rules are unit-tested; the SpecLibrary
// agent in server.ts stores the result.
import { validateSpec } from "./parse";
import type { Spec, SpecPart } from "./types";

export type SpecRevisionRecord = {
  spec: Spec;
  savedAt: string;
  note: string;
  /** Readable summary of what changed from the previous revision. */
  changes: string[];
};

/** specId -> revisions, oldest first; the last entry is current. */
export type SpecLibraryState = { specs: Record<string, SpecRevisionRecord[]> };

export type SpecSummary = {
  specId: string;
  revision: string;
  rackName: string;
  partCount: number;
  powerBudgetW: number;
  savedAt: string;
  revisions: number;
};

export type SaveResult =
  | { ok: true; state: SpecLibraryState; record: SpecRevisionRecord }
  | { ok: false; problems: string[] };

export function currentSpec(
  state: SpecLibraryState,
  specId: string
): Spec | null {
  const history = state.specs[specId];
  return history?.length ? history[history.length - 1].spec : null;
}

export function summarize(state: SpecLibraryState): SpecSummary[] {
  return Object.values(state.specs)
    .filter((h) => h.length > 0)
    .map((h) => {
      const { spec, savedAt } = h[h.length - 1];
      return {
        specId: spec.specId,
        revision: spec.revision,
        rackName: spec.rackName,
        partCount: spec.parts.length,
        powerBudgetW: spec.powerBudgetW,
        savedAt,
        revisions: h.length
      };
    })
    .sort((a, b) => a.specId.localeCompare(b.specId));
}

const list = (xs: string[]) => xs.join(", ") || "(none)";
const subsKey = (p: SpecPart) =>
  p.approvedSubstitutes
    .map((s) => `${s.partNumber}/${s.manufacturer}/rev ${s.revision}`)
    .join("; ");

function partChanges(prev: SpecPart, next: SpecPart): string[] {
  const out: string[] = [];
  const field = (label: string, a: unknown, b: unknown) => {
    if (String(a) !== String(b)) out.push(`${label} ${a} → ${b}`);
  };
  field("rev", prev.revision, next.revision);
  field("qty", prev.qtyPerRack, next.qtyPerRack);
  field("watts", prev.wattsEach, next.wattsEach);
  if (prev.description !== next.description) out.push("description updated");
  if (list(prev.approvedManufacturers) !== list(next.approvedManufacturers)) {
    out.push(
      `manufacturers ${list(prev.approvedManufacturers)} → ${list(next.approvedManufacturers)}`
    );
  }
  if (subsKey(prev) !== subsKey(next))
    out.push(
      `substitutes ${subsKey(prev) || "(none)"} → ${subsKey(next) || "(none)"}`
    );
  return out;
}

/** Human-readable list of differences between two revisions of a spec. */
export function diffSpecs(prev: Spec | null, next: Spec): string[] {
  if (!prev)
    return [
      `New spec ${next.specId} rev ${next.revision} with ${next.parts.length} parts`
    ];
  const out: string[] = [];
  if (prev.revision !== next.revision)
    out.push(`Revision ${prev.revision} → ${next.revision}`);
  if (prev.rackName !== next.rackName)
    out.push(`Rack name "${prev.rackName}" → "${next.rackName}"`);
  if (prev.powerBudgetW !== next.powerBudgetW)
    out.push(`Power budget ${prev.powerBudgetW} W → ${next.powerBudgetW} W`);
  const before = new Map(prev.parts.map((p) => [p.partNumber, p]));
  const after = new Map(next.parts.map((p) => [p.partNumber, p]));
  for (const [pn, p] of after) {
    const old = before.get(pn);
    if (!old)
      out.push(
        `Added ${pn} (${p.description}, qty ${p.qtyPerRack}, rev ${p.revision})`
      );
    else {
      const c = partChanges(old, p);
      if (c.length) out.push(`${pn}: ${c.join("; ")}`);
    }
  }
  for (const pn of before.keys()) if (!after.has(pn)) out.push(`Removed ${pn}`);
  return out;
}

/**
 * Saves a spec as a new revision. Rules:
 * - the spec must pass the same validation as an uploaded spec.json;
 * - changing an existing spec requires a new revision label, so the gold
 *   standard never changes silently under reviews that cite it;
 * - a revision label cannot be reused, and saving with no changes is refused.
 */
export function saveSpec(
  state: SpecLibraryState,
  raw: unknown,
  note: string,
  now = new Date()
): SaveResult {
  const valid = validateSpec(raw);
  if (!valid.ok) return valid;
  const spec = valid.spec;
  const history = state.specs[spec.specId] ?? [];
  const prev = history.length ? history[history.length - 1].spec : null;
  const changes = diffSpecs(prev, spec);

  if (prev) {
    if (changes.length === 0)
      return { ok: false, problems: ["No changes to save."] };
    if (prev.revision === spec.revision) {
      return {
        ok: false,
        problems: [
          `Changes need a new revision label: ${spec.specId} is currently rev ${prev.revision}.`
        ]
      };
    }
    if (history.some((r) => r.spec.revision === spec.revision)) {
      return {
        ok: false,
        problems: [
          `Revision ${spec.revision} was already used for ${spec.specId}; pick a new label.`
        ]
      };
    }
  }

  const record: SpecRevisionRecord = {
    spec,
    savedAt: now.toISOString(),
    note: note.trim() || (prev ? "Updated" : "Created"),
    changes
  };
  return {
    ok: true,
    record,
    state: { specs: { ...state.specs, [spec.specId]: [...history, record] } }
  };
}

/** Suggests the next revision label: C → D, 1.2 → 1.3, otherwise appends "-1". */
export function nextRevision(rev: string): string {
  if (/^[A-Y]$/.test(rev)) return String.fromCharCode(rev.charCodeAt(0) + 1);
  const num = rev.match(/^(.*?)(\d+)$/);
  if (num) return `${num[1]}${Number(num[2]) + 1}`;
  return `${rev}-1`;
}
