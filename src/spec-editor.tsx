// Rack spec library UI: browse specs, edit the gold standard as a new revision,
// create specs for other rack designs, import/export spec.json, view history.
import { useEffect, useMemo, useState } from "react";
import { useAgent } from "agents/react";
import { Badge, Button, Surface, Text } from "@cloudflare/kumo";
import {
  CopySimpleIcon,
  DownloadSimpleIcon,
  PlusIcon,
  TrashIcon,
  UploadSimpleIcon
} from "@phosphor-icons/react";
import { validateSpec } from "./parse";
import type { SpecLibrary } from "./spec-agent";
import {
  currentSpec,
  diffSpecs,
  nextRevision,
  summarize,
  type SpecLibraryState
} from "./spec-library";
import type { Spec } from "./types";

// The form keeps raw strings so partially typed numbers and lists survive edits.
type FormPart = {
  partNumber: string;
  description: string;
  revision: string;
  qty: string;
  watts: string;
  /** Comma-separated manufacturers. */
  mfrs: string;
  /** "PART | manufacturer | rev" entries separated by semicolons. */
  subs: string;
};
type Form = {
  specId: string;
  revision: string;
  rackName: string;
  powerBudgetW: string;
  parts: FormPart[];
};

const blankPart = (): FormPart => ({
  partNumber: "",
  description: "",
  revision: "A",
  qty: "1",
  watts: "0",
  mfrs: "",
  subs: ""
});

function fromSpec(s: Spec): Form {
  return {
    specId: s.specId,
    revision: s.revision,
    rackName: s.rackName,
    powerBudgetW: String(s.powerBudgetW),
    parts: s.parts.map((p) => ({
      partNumber: p.partNumber,
      description: p.description,
      revision: p.revision,
      qty: String(p.qtyPerRack),
      watts: String(p.wattsEach),
      mfrs: p.approvedManufacturers.join(", "),
      subs: p.approvedSubstitutes
        .map((x) => `${x.partNumber} | ${x.manufacturer} | ${x.revision}`)
        .join("; ")
    }))
  };
}

const num = (v: string) => (v.trim() === "" ? Number.NaN : Number(v));

/** Converts the form to a raw spec object; validateSpec decides if it is valid. */
function toRaw(f: Form): unknown {
  return {
    specId: f.specId.trim(),
    revision: f.revision.trim(),
    rackName: f.rackName.trim(),
    powerBudgetW: num(f.powerBudgetW),
    parts: f.parts.map((p) => ({
      partNumber: p.partNumber.trim(),
      description: p.description.trim(),
      revision: p.revision.trim(),
      qtyPerRack: num(p.qty),
      wattsEach: num(p.watts),
      approvedManufacturers: p.mfrs
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean),
      approvedSubstitutes: p.subs
        .split(";")
        .map((e) => e.trim())
        .filter(Boolean)
        .map((e) => {
          const [partNumber = "", manufacturer = "", revision = ""] = e
            .split("|")
            .map((x) => x.trim());
          return { partNumber, manufacturer, revision };
        })
    }))
  };
}

function download(spec: Spec) {
  const blob = new Blob([JSON.stringify(spec, null, 2) + "\n"], {
    type: "application/json"
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${spec.specId}-rev-${spec.revision}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

const input =
  "rounded-md bg-kumo-base ring ring-kumo-line px-2 py-1 text-xs text-kumo-default w-full";

export function SpecLibraryView() {
  const lib = useAgent<SpecLibrary, SpecLibraryState>({
    agent: "SpecLibrary",
    name: "default"
  });
  const state = lib.state;
  const specs = useMemo(() => (state ? summarize(state) : []), [state]);

  const [selected, setSelected] = useState<string | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [note, setNote] = useState("");
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const current =
    state && selected && !isNew ? currentSpec(state, selected) : null;

  // Open the first spec once the library loads.
  useEffect(() => {
    if (!selected && specs.length > 0) setSelected(specs[0].specId);
  }, [specs, selected]);

  // Reset the form whenever the selected spec (or its saved revision) changes.
  useEffect(() => {
    if (current && !isNew) setForm(fromSpec(current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, current?.revision, isNew]);

  if (!state) {
    return (
      <div className="flex-1 flex items-center justify-center text-kumo-inactive">
        Loading spec library…
      </div>
    );
  }

  const raw = form ? toRaw(form) : null;
  const check = raw ? validateSpec(raw) : null;
  const changes = check?.ok
    ? diffSpecs(isNew ? null : current, check.spec)
    : [];
  const needsBump =
    !isNew &&
    !!current &&
    changes.length > 0 &&
    form?.revision.trim() === current.revision;
  const nameplateW =
    check?.ok &&
    check.spec.parts.reduce((t, p) => t + p.qtyPerRack * p.wattsEach, 0);
  const history = selected && !isNew ? (state.specs[selected] ?? []) : [];

  const update = (patch: Partial<Form>) => {
    setSaved(null);
    setForm((f) => (f ? { ...f, ...patch } : f));
  };
  const updatePart = (i: number, patch: Partial<FormPart>) => {
    setSaved(null);
    setForm((f) =>
      f
        ? {
            ...f,
            parts: f.parts.map((p, j) => (j === i ? { ...p, ...patch } : p))
          }
        : f
    );
  };

  const startNew = (base?: Spec) => {
    setIsNew(true);
    setSelected(null);
    setProblems([]);
    setSaved(null);
    setNote("");
    setForm(
      base
        ? {
            ...fromSpec(base),
            specId: "",
            revision: "A",
            rackName: `${base.rackName} (copy)`
          }
        : {
            specId: "",
            revision: "A",
            rackName: "",
            powerBudgetW: "10000",
            parts: [blankPart()]
          }
    );
  };

  const open = (specId: string) => {
    setIsNew(false);
    setSelected(specId);
    setProblems([]);
    setSaved(null);
    setNote("");
  };

  const importFile = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as Spec;
      const exists = !!state.specs[parsed.specId];
      setIsNew(!exists);
      setSelected(exists ? parsed.specId : null);
      // Defer so the reset effect for the selected spec runs first.
      setTimeout(() => setForm(fromSpec(parsed)), 0);
      setProblems([]);
      setNote(`Imported from ${file.name}`);
    } catch {
      setProblems([`${file.name} is not valid JSON`]);
    }
  };

  const save = async () => {
    if (!check?.ok) return;
    setBusy(true);
    setProblems([]);
    try {
      const res = await lib.stub.save(check.spec, note);
      if (!res.ok) {
        setProblems(res.problems);
      } else {
        setSaved(
          `Saved ${res.record.spec.specId} rev ${res.record.spec.revision}.`
        );
        setNote("");
        setIsNew(false);
        setSelected(res.record.spec.specId);
      }
    } catch (e) {
      setProblems([e instanceof Error ? e.message : String(e)]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex-1 flex min-h-0">
      {/* Spec list */}
      <aside className="w-64 border-r border-kumo-line bg-kumo-base p-3 space-y-2 overflow-y-auto">
        <Text size="sm" bold>
          Rack specs
        </Text>
        {specs.map((s) => (
          <button
            key={s.specId}
            type="button"
            onClick={() => open(s.specId)}
            className={`w-full text-left rounded-lg px-3 py-2 ring ${selected === s.specId && !isNew ? "ring-kumo-brand bg-kumo-elevated" : "ring-kumo-line"}`}
          >
            <div className="font-mono text-xs">{s.specId}</div>
            <div className="text-xs text-kumo-inactive">
              rev {s.revision} · {s.partCount} parts · {s.revisions} revision
              {s.revisions === 1 ? "" : "s"}
            </div>
          </button>
        ))}
        <div className="pt-2 space-y-2">
          <Button
            size="sm"
            variant="secondary"
            icon={<PlusIcon size={14} />}
            onClick={() => startNew()}
          >
            New rack spec
          </Button>
          <label className="flex items-center gap-1 text-xs cursor-pointer text-kumo-default">
            <UploadSimpleIcon size={14} /> Import spec.json
            <input
              type="file"
              accept=".json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) importFile(f);
                e.target.value = "";
              }}
            />
          </label>
        </div>
        <Text size="xs" variant="secondary">
          Reviews use the current revision of a spec and keep a snapshot, so
          saving here never changes a review that already ran.
        </Text>
      </aside>

      {/* Editor */}
      <main className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
        {!form ? (
          <Text variant="secondary">Select a spec or create a new one.</Text>
        ) : (
          <>
            <div className="flex items-center gap-2 flex-wrap">
              <Text variant="heading3" as="h2">
                {isNew ? "New rack spec" : `Edit ${selected}`}
              </Text>
              {!isNew && current && (
                <Badge variant="secondary">
                  current rev {current.revision}
                </Badge>
              )}
              <div className="flex-1" />
              {!isNew && current && (
                <>
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<CopySimpleIcon size={14} />}
                    onClick={() => startNew(current)}
                  >
                    Duplicate as new rack
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<DownloadSimpleIcon size={14} />}
                    onClick={() => download(current)}
                  >
                    Export JSON
                  </Button>
                </>
              )}
            </div>

            {/* Header fields */}
            <Surface className="rounded-xl ring ring-kumo-line p-4 grid grid-cols-4 gap-3">
              <label className="text-xs space-y-1">
                <div className="text-kumo-inactive">Spec ID</div>
                <input
                  aria-label="Spec ID"
                  className={input}
                  value={form.specId}
                  disabled={!isNew}
                  placeholder="RS-STORAGE-42U"
                  onChange={(e) => update({ specId: e.target.value })}
                />
              </label>
              <label className="text-xs space-y-1">
                <div className="text-kumo-inactive">Revision</div>
                <div className="flex gap-1">
                  <input
                    aria-label="Revision"
                    className={input}
                    value={form.revision}
                    onChange={(e) => update({ revision: e.target.value })}
                  />
                  {needsBump && current && (
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() =>
                        update({ revision: nextRevision(current.revision) })
                      }
                    >
                      Bump to {nextRevision(current.revision)}
                    </Button>
                  )}
                </div>
              </label>
              <label className="text-xs space-y-1">
                <div className="text-kumo-inactive">Rack name</div>
                <input
                  aria-label="Rack name"
                  className={input}
                  value={form.rackName}
                  onChange={(e) => update({ rackName: e.target.value })}
                />
              </label>
              <label className="text-xs space-y-1">
                <div className="text-kumo-inactive">Power budget (W)</div>
                <input
                  aria-label="Power budget"
                  className={input}
                  inputMode="numeric"
                  value={form.powerBudgetW}
                  onChange={(e) => update({ powerBudgetW: e.target.value })}
                />
              </label>
              <div className="col-span-4 text-xs text-kumo-inactive">
                {form.parts.length} parts
                {typeof nameplateW === "number" && num(form.powerBudgetW) > 0
                  ? ` · nameplate draw at full quantity ${Math.round(nameplateW)} W (${Math.round((nameplateW / num(form.powerBudgetW)) * 100)}% of budget)`
                  : ""}
              </div>
            </Surface>

            {/* Parts */}
            <div className="overflow-x-auto rounded-xl ring ring-kumo-line">
              <table className="w-full text-xs">
                <thead className="bg-kumo-base text-left text-kumo-inactive">
                  <tr>
                    <th className="px-2 py-2 font-medium">Part number</th>
                    <th className="px-2 py-2 font-medium">Description</th>
                    <th className="px-2 py-2 font-medium w-16">Rev</th>
                    <th className="px-2 py-2 font-medium w-16">Qty / rack</th>
                    <th className="px-2 py-2 font-medium w-16">Watts each</th>
                    <th className="px-2 py-2 font-medium">
                      Approved manufacturers (comma-separated)
                    </th>
                    <th className="px-2 py-2 font-medium">
                      Approved substitutes (PART | mfr | rev; …)
                    </th>
                    <th className="px-2 py-2">
                      <span className="sr-only">Remove</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {form.parts.map((p, i) => (
                    <tr key={i} className="border-t border-kumo-line">
                      {(
                        [
                          ["partNumber", "font-mono"],
                          ["description", ""],
                          ["revision", ""],
                          ["qty", ""],
                          ["watts", ""],
                          ["mfrs", ""],
                          ["subs", ""]
                        ] as const
                      ).map(([field, cls]) => (
                        <td key={field} className="px-2 py-1">
                          <input
                            aria-label={`${field} for part ${i + 1}`}
                            className={`${input} ${cls}`}
                            value={p[field]}
                            onChange={(e) =>
                              updatePart(i, { [field]: e.target.value })
                            }
                          />
                        </td>
                      ))}
                      <td className="px-2 py-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          shape="square"
                          aria-label={`Remove part ${i + 1}`}
                          icon={<TrashIcon size={14} />}
                          onClick={() =>
                            update({
                              parts: form.parts.filter((_, j) => j !== i)
                            })
                          }
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Button
              size="sm"
              variant="secondary"
              icon={<PlusIcon size={14} />}
              onClick={() => update({ parts: [...form.parts, blankPart()] })}
            >
              Add part
            </Button>

            {/* Validation, change preview, save */}
            <Surface className="rounded-xl ring ring-kumo-line p-4 space-y-3">
              {check && !check.ok && (
                <div className="text-xs text-kumo-danger space-y-0.5">
                  <div className="font-semibold">Fix before saving:</div>
                  {check.problems.slice(0, 8).map((p) => (
                    <div key={p}>• {p}</div>
                  ))}
                  {check.problems.length > 8 && (
                    <div>…and {check.problems.length - 8} more</div>
                  )}
                </div>
              )}
              {check?.ok && (
                <div className="text-xs space-y-0.5">
                  <div className="font-semibold">
                    {changes.length === 0
                      ? "No changes yet."
                      : `Changes to save (${changes.length}):`}
                  </div>
                  {changes.map((c) => (
                    <div key={c}>• {c}</div>
                  ))}
                  {needsBump && (
                    <div className="text-kumo-danger">
                      Changing the gold standard needs a new revision label
                      (currently rev {current?.revision}).
                    </div>
                  )}
                </div>
              )}
              <div className="flex items-center gap-2">
                <input
                  aria-label="Change note"
                  className={`${input} max-w-md`}
                  placeholder="Change note, e.g. ECO-114: PDU moves to rev E"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
                <Button
                  variant="primary"
                  disabled={
                    busy || !check?.ok || changes.length === 0 || needsBump
                  }
                  onClick={save}
                >
                  {isNew
                    ? "Create spec"
                    : `Save as rev ${form.revision.trim() || "?"}`}
                </Button>
                {!isNew && current && (
                  <Button
                    variant="secondary"
                    onClick={() => setForm(fromSpec(current))}
                  >
                    Discard changes
                  </Button>
                )}
              </div>
              {problems.length > 0 && (
                <div className="text-xs text-kumo-danger">
                  {problems.map((p) => (
                    <div key={p}>{p}</div>
                  ))}
                </div>
              )}
              {saved && (
                <div className="text-xs text-kumo-success">{saved}</div>
              )}
            </Surface>

            {/* History */}
            {history.length > 0 && (
              <details
                className="rounded-xl ring ring-kumo-line px-4 py-3"
                open
              >
                <summary className="cursor-pointer text-sm font-semibold">
                  Revision history ({history.length})
                </summary>
                <ul className="mt-2 space-y-2 text-xs">
                  {[...history].reverse().map((r) => (
                    <li
                      key={r.spec.revision}
                      className="border-t border-kumo-line pt-2"
                    >
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary">rev {r.spec.revision}</Badge>
                        <span className="text-kumo-inactive">
                          {new Date(r.savedAt).toLocaleString()}
                        </span>
                        <span>{r.note}</span>
                        <div className="flex-1" />
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={<DownloadSimpleIcon size={12} />}
                          onClick={() => download(r.spec)}
                        >
                          JSON
                        </Button>
                      </div>
                      <ul className="pl-4 list-disc text-kumo-inactive">
                        {r.changes.map((c) => (
                          <li key={c}>{c}</li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </main>
    </div>
  );
}

/** Library specs for pickers elsewhere in the UI (e.g. the upload form). */
export function useSpecList() {
  const lib = useAgent<SpecLibrary, SpecLibraryState>({
    agent: "SpecLibrary",
    name: "default"
  });
  return useMemo(() => (lib.state ? summarize(lib.state) : []), [lib.state]);
}
