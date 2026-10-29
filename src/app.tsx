import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import {
  Badge,
  Button,
  Empty,
  InputArea,
  PoweredByCloudflare,
  Surface,
  Text
} from "@cloudflare/kumo";
import { Streamdown } from "streamdown";
import {
  CheckCircleIcon,
  CircleIcon,
  CopyIcon,
  GaugeIcon,
  MoonIcon,
  PaperPlaneRightIcon,
  StopIcon,
  SunIcon,
  TrashIcon,
  UploadSimpleIcon,
  WarningOctagonIcon,
  WrenchIcon
} from "@phosphor-icons/react";
import type { ReviewAgent, StartResult } from "./server";
import type { Finding, FindingDecision, ReviewState, Severity } from "./types";
import { DEMO_BUILD_IDS, type DemoName } from "./demo";
import type { RawReviewFiles } from "./parse";
import { summarizeUsage } from "./usage";

// ── Small pieces ──────────────────────────────────────────────────────

const SEVERITY_BADGE: Record<
  Severity,
  "destructive" | "primary" | "secondary"
> = {
  blocker: "destructive",
  "needs-review": "primary",
  info: "secondary"
};

const SEVERITY_LABEL: Record<Severity, string> = {
  blocker: "Blocker",
  "needs-review": "Needs review",
  info: "Info"
};

const STEPS: { key: string; label: string }[] = [
  { key: "running", label: "Rules + LLM" },
  { key: "awaiting-approval", label: "Human approval" },
  { key: "drafting", label: "Drafting note" },
  { key: "complete", label: "Complete" }
];

function ThemeToggle() {
  const [dark, setDark] = useState(
    () => document.documentElement.getAttribute("data-mode") === "dark"
  );
  const toggle = useCallback(() => {
    const mode = dark ? "light" : "dark";
    setDark(!dark);
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    localStorage.setItem("theme", mode);
  }, [dark]);
  return (
    <Button
      variant="ghost"
      shape="square"
      aria-label="Toggle theme"
      onClick={toggle}
      icon={dark ? <SunIcon size={16} /> : <MoonIcon size={16} />}
    />
  );
}

const fmtUsd = (n: number) =>
  n < 0.01 && n > 0 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
const fmtTokens = (n: number) =>
  n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n);

function UsageMeter({ state }: { state: ReviewState }) {
  const [open, setOpen] = useState(false);
  const { total, byModel, bySource } = useMemo(
    () => summarizeUsage(state.usage),
    [state.usage]
  );
  return (
    <div className="relative">
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setOpen(!open)}
        icon={<GaugeIcon size={14} />}
      >
        {total.calls} LLM calls · {fmtTokens(total.inputTokens)} in /{" "}
        {fmtTokens(total.outputTokens)} out · {fmtUsd(total.estCostUsd)}
      </Button>
      {open && (
        <Surface className="absolute right-0 top-full mt-2 z-50 w-[26rem] rounded-xl ring ring-kumo-line shadow-lg p-4 space-y-3">
          <Text size="sm" bold>
            Usage (estimate)
          </Text>
          <table className="w-full text-xs">
            <thead className="text-kumo-inactive text-left">
              <tr>
                <th className="font-normal pb-1">Model</th>
                <th className="font-normal pb-1 text-right">Calls</th>
                <th className="font-normal pb-1 text-right">In</th>
                <th className="font-normal pb-1 text-right">Out</th>
                <th className="font-normal pb-1 text-right">Est. $</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(byModel).map(([id, t]) => (
                <tr key={id} className="text-kumo-default">
                  <td className="py-0.5 truncate max-w-[11rem]" title={id}>
                    {id.split("/").pop()}
                  </td>
                  <td className="text-right">{t.calls}</td>
                  <td className="text-right">{fmtTokens(t.inputTokens)}</td>
                  <td className="text-right">{fmtTokens(t.outputTokens)}</td>
                  <td className="text-right">{fmtUsd(t.estCostUsd)}</td>
                </tr>
              ))}
              {total.calls === 0 && (
                <tr>
                  <td colSpan={5} className="py-1 text-kumo-inactive">
                    No LLM calls yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <div className="flex gap-2 flex-wrap text-xs">
            {(["judge", "draft", "chat"] as const).map((src) => (
              <Badge key={src} variant="secondary">
                {src}: {bySource[src].calls} ·{" "}
                {fmtUsd(bySource[src].estCostUsd)}
              </Badge>
            ))}
            <Badge variant="secondary">rule checks: 0 LLM calls</Badge>
          </div>
          <Text size="xs" variant="secondary">
            Cost uses list prices per million tokens; the Workers AI free
            allowance is not deducted.
          </Text>
        </Surface>
      )}
    </div>
  );
}

function StatusSteps({ status }: { status: ReviewState["status"] }) {
  const idx = STEPS.findIndex((s) => s.key === status);
  return (
    <div className="flex items-center gap-2 text-xs">
      {STEPS.map((s, i) => {
        const done = idx > i || status === "complete";
        const active = idx === i && status !== "complete";
        return (
          <div key={s.key} className="flex items-center gap-2">
            <span
              className={`flex items-center gap-1 ${done ? "text-kumo-success" : active ? "text-kumo-brand font-semibold" : "text-kumo-inactive"}`}
            >
              {done ? (
                <CheckCircleIcon size={14} weight="fill" />
              ) : (
                <CircleIcon size={14} weight={active ? "fill" : "regular"} />
              )}
              {s.label}
            </span>
            {i < STEPS.length - 1 && (
              <span className="text-kumo-inactive">→</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Findings table with approval ──────────────────────────────────────

type Draft = Required<Pick<FindingDecision, "status" | "severity">> & {
  suggestedAction: string;
  reviewerNote: string;
};

function FindingsTable({
  findings,
  editable,
  drafts,
  setDraft
}: {
  findings: Finding[];
  editable: boolean;
  drafts: Record<string, Draft>;
  setDraft: (id: string, d: Partial<Draft>) => void;
}) {
  if (findings.length === 0) return null;
  return (
    <div className="overflow-x-auto rounded-xl ring ring-kumo-line">
      <table className="w-full text-sm">
        <thead className="bg-kumo-base text-left text-xs text-kumo-inactive">
          <tr>
            <th className="px-3 py-2 font-medium">ID</th>
            <th className="px-3 py-2 font-medium">Line</th>
            <th className="px-3 py-2 font-medium">Severity</th>
            <th className="px-3 py-2 font-medium">Finding</th>
            <th className="px-3 py-2 font-medium">Source</th>
            <th className="px-3 py-2 font-medium">
              {editable ? "Decision" : "Status"}
            </th>
          </tr>
        </thead>
        <tbody>
          {findings.map((f) => {
            const d = drafts[f.id];
            const rejected = editable
              ? d?.status === "rejected"
              : f.status === "rejected";
            return (
              <tr
                key={f.id}
                className={`border-t border-kumo-line align-top ${rejected ? "opacity-50" : ""}`}
              >
                <td className="px-3 py-2 font-mono text-xs text-kumo-inactive">
                  {f.id}
                </td>
                <td className="px-3 py-2 font-mono">{f.line ?? "rack"}</td>
                <td className="px-3 py-2">
                  {editable && d ? (
                    <select
                      aria-label={`Severity for ${f.id}`}
                      className="rounded-md bg-kumo-base ring ring-kumo-line px-1.5 py-1 text-xs"
                      value={d.severity}
                      onChange={(e) =>
                        setDraft(f.id, { severity: e.target.value as Severity })
                      }
                    >
                      {(Object.keys(SEVERITY_LABEL) as Severity[]).map((s) => (
                        <option key={s} value={s}>
                          {SEVERITY_LABEL[s]}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <Badge variant={SEVERITY_BADGE[f.severity]}>
                      {SEVERITY_LABEL[f.severity]}
                    </Badge>
                  )}
                </td>
                <td className="px-3 py-2 space-y-1 min-w-[22rem]">
                  <div className="text-kumo-default">
                    <span className="font-mono text-xs">{f.partNumber}</span>{" "}
                    <span className="text-kumo-inactive">· {f.category}</span>
                  </div>
                  <div className="text-xs text-kumo-default">
                    Expected <b>{f.expected}</b>, found <b>{f.found}</b>
                  </div>
                  <div className="text-xs text-kumo-inactive">{f.evidence}</div>
                  {editable && d ? (
                    <>
                      <input
                        aria-label={`Suggested action for ${f.id}`}
                        className="w-full rounded-md bg-kumo-base ring ring-kumo-line px-2 py-1 text-xs"
                        value={d.suggestedAction}
                        onChange={(e) =>
                          setDraft(f.id, { suggestedAction: e.target.value })
                        }
                      />
                      <input
                        aria-label={`Reviewer note for ${f.id}`}
                        placeholder="Reviewer note (optional, included in the ODM note)"
                        className="w-full rounded-md bg-kumo-base ring ring-kumo-line px-2 py-1 text-xs"
                        value={d.reviewerNote}
                        onChange={(e) =>
                          setDraft(f.id, { reviewerNote: e.target.value })
                        }
                      />
                    </>
                  ) : (
                    <div className="text-xs">
                      <span className="text-kumo-inactive">Action:</span>{" "}
                      {f.suggestedAction}
                      {f.reviewerNote && (
                        <div className="italic">Reviewer: {f.reviewerNote}</div>
                      )}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2 text-xs">
                  {f.source === "llm" ? (
                    <span title={f.modelId}>
                      LLM · {f.modelId?.split("/").pop()}
                    </span>
                  ) : (
                    "Rule"
                  )}
                </td>
                <td className="px-3 py-2">
                  {editable && d ? (
                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        variant={
                          d.status === "approved" ? "primary" : "secondary"
                        }
                        onClick={() => setDraft(f.id, { status: "approved" })}
                      >
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant={
                          d.status === "rejected" ? "destructive" : "secondary"
                        }
                        onClick={() => setDraft(f.id, { status: "rejected" })}
                      >
                        Reject
                      </Button>
                    </div>
                  ) : (
                    <Badge variant="secondary">{f.status}</Badge>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Chat ──────────────────────────────────────────────────────────────

function ChatPanel({
  agent,
  connected
}: {
  agent: ReturnType<typeof useAgent<ReviewAgent, ReviewState>>;
  connected: boolean;
}) {
  const [input, setInput] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const { messages, sendMessage, clearHistory, stop, status } = useAgentChat({
    agent,
    experimental_throttle: 100
  });
  const streaming = status === "streaming" || status === "submitted";

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = (text: string) => {
    if (!text.trim() || streaming) return;
    sendMessage({ role: "user", parts: [{ type: "text", text: text.trim() }] });
    setInput("");
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-kumo-line">
        <Text size="sm" bold>
          Ask about this review
        </Text>
        <Button
          variant="ghost"
          size="sm"
          icon={<TrashIcon size={14} />}
          onClick={clearHistory}
          aria-label="Clear chat"
        >
          Clear
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {messages.length === 0 && (
          <div className="space-y-2">
            <Text size="xs" variant="secondary">
              Try:
            </Text>
            {[
              "What is blocking this build?",
              "Why did you flag the transceiver line?",
              "Which findings came from the LLM?"
            ].map((q) => (
              <Button
                key={q}
                size="sm"
                variant="secondary"
                onClick={() => send(q)}
                disabled={!connected}
              >
                {q}
              </Button>
            ))}
          </div>
        )}
        {messages.map((m: UIMessage) => (
          <div
            key={m.id}
            className={m.role === "user" ? "flex justify-end" : ""}
          >
            <div
              className={`max-w-[92%] rounded-xl px-3 py-2 text-sm ${m.role === "user" ? "bg-kumo-contrast text-kumo-inverse" : "bg-kumo-base ring ring-kumo-line"}`}
            >
              {m.parts.map((p, i) => {
                if (p.type === "text") {
                  return m.role === "user" ? (
                    <span key={i}>{p.text}</span>
                  ) : (
                    <Streamdown
                      key={i}
                      className="sd-theme"
                      isAnimating={streaming}
                    >
                      {p.text}
                    </Streamdown>
                  );
                }
                if (isToolUIPart(p)) {
                  return (
                    <div
                      key={i}
                      className="flex items-center gap-1 text-xs text-kumo-inactive"
                    >
                      <WrenchIcon size={12} /> {getToolName(p)}
                    </div>
                  );
                }
                return null;
              })}
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <form
        className="p-3 border-t border-kumo-line flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <InputArea
          value={input}
          onValueChange={setInput}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(input);
            }
          }}
          placeholder="e.g. why did you flag line 14?"
          rows={2}
          disabled={!connected}
          className="flex-1 resize-none"
        />
        {streaming ? (
          <Button
            type="button"
            variant="secondary"
            shape="square"
            aria-label="Stop"
            icon={<StopIcon size={16} />}
            onClick={stop}
          />
        ) : (
          <Button
            type="submit"
            variant="primary"
            shape="square"
            aria-label="Send"
            disabled={!input.trim() || !connected}
            icon={<PaperPlaneRightIcon size={16} />}
          />
        )}
      </form>
    </div>
  );
}

// ── Review workspace (one agent instance per build) ───────────────────

function Workspace({
  buildId,
  pendingFiles,
  onPendingHandled
}: {
  buildId: string;
  pendingFiles: RawReviewFiles | null;
  onPendingHandled: () => void;
}) {
  const [connected, setConnected] = useState(false);
  const [models, setModels] = useState<
    { id: string; label: string; requires?: string }[]
  >([]);
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});

  const agent = useAgent<ReviewAgent, ReviewState>({
    agent: "ReviewAgent",
    name: buildId,
    onOpen: useCallback(() => setConnected(true), []),
    onClose: useCallback(() => setConnected(false), [])
  });
  const state = agent.state;

  useEffect(() => {
    if (connected)
      agent.stub
        .listModels()
        .then(setModels)
        .catch(() => {});
  }, [connected, agent]);

  const run = useCallback(async (fn: () => Promise<StartResult | void>) => {
    setBusy(true);
    setProblems([]);
    try {
      const res = await fn();
      if (res && !res.ok) setProblems(res.problems);
    } catch (e) {
      setProblems([e instanceof Error ? e.message : String(e)]);
    } finally {
      setBusy(false);
    }
  }, []);

  // Uploaded files wait here until the socket for their build is open.
  useEffect(() => {
    if (connected && pendingFiles) {
      onPendingHandled();
      run(() => agent.stub.startReview(pendingFiles));
    }
  }, [connected, pendingFiles, onPendingHandled, run, agent]);

  // Fresh decision drafts each time a new set of findings arrives for approval.
  const findingsKey = state?.findings.map((f) => f.id).join(",") ?? "";
  useEffect(() => {
    if (state?.status !== "awaiting-approval") return;
    setDrafts(
      Object.fromEntries(
        state.findings.map((f) => [
          f.id,
          {
            status: "approved",
            severity: f.severity,
            suggestedAction: f.suggestedAction,
            reviewerNote: ""
          } satisfies Draft
        ])
      )
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findingsKey, state?.status]);

  if (!state) {
    return (
      <div className="flex-1 flex items-center justify-center text-kumo-inactive">
        Connecting to review {buildId}...
      </div>
    );
  }

  const editable = state.status === "awaiting-approval";
  const live: Finding[] = editable
    ? state.findings.map((f) => ({
        ...f,
        severity: drafts[f.id]?.severity ?? f.severity,
        status: drafts[f.id]?.status ?? "approved"
      }))
    : state.findings;
  const counts = { blocker: 0, "needs-review": 0, info: 0 } as Record<
    Severity,
    number
  >;
  for (const f of live) if (f.status !== "rejected") counts[f.severity]++;
  const verdict =
    state.findings.length === 0 ? null : counts.blocker > 0 ? "hold" : "ready";

  const submit = () =>
    run(() =>
      agent.stub.submitDecisions(
        state.findings.map((f) => ({
          id: f.id,
          status: drafts[f.id].status,
          severity: drafts[f.id].severity,
          suggestedAction: drafts[f.id].suggestedAction,
          reviewerNote: drafts[f.id].reviewerNote
        }))
      )
    );

  return (
    <div className="flex-1 flex min-h-0">
      <main className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
        {/* Controls */}
        <div className="flex items-center gap-3 flex-wrap">
          <Text variant="heading3" as="h2">
            Build {buildId}
          </Text>
          <span className="flex items-center gap-1 text-xs text-kumo-inactive">
            <CircleIcon
              size={8}
              weight="fill"
              className={connected ? "text-kumo-success" : "text-kumo-danger"}
            />
            {connected ? "Connected" : "Offline"}
          </span>
          <div className="flex-1" />
          <label className="flex items-center gap-2 text-xs text-kumo-inactive">
            Model
            <select
              aria-label="LLM model"
              className="rounded-md bg-kumo-base ring ring-kumo-line px-2 py-1.5 text-sm text-kumo-default"
              value={state.modelId}
              disabled={!connected}
              onChange={(e) => run(() => agent.stub.setModel(e.target.value))}
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                  {m.requires ? ` (${m.requires})` : ""}
                </option>
              ))}
            </select>
          </label>
          <UsageMeter state={state} />
        </div>

        {problems.length > 0 && (
          <Surface className="rounded-xl ring-2 ring-kumo-danger px-4 py-3">
            <Text size="sm" bold>
              Could not continue
            </Text>
            <ul className="list-disc pl-5 text-sm">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </Surface>
        )}

        {state.status === "idle" ? (
          <Empty
            title="No review yet"
            description="Load a demo BOM or upload a spec, BOM, cert list and build context."
            contents={
              <Button
                variant="primary"
                disabled={!connected || busy}
                onClick={() =>
                  run(() =>
                    agent.stub.loadDemo(
                      buildId === DEMO_BUILD_IDS.clean ? "clean" : "issues"
                    )
                  )
                }
              >
                Run review
              </Button>
            }
          />
        ) : (
          <>
            {/* Verdict */}
            <Surface className="rounded-xl ring ring-kumo-line px-5 py-4 flex items-center gap-6 flex-wrap">
              <div>
                <Text size="xs" variant="secondary">
                  Verdict{editable ? " (live, as you decide)" : ""}
                </Text>
                <div
                  className={`text-3xl font-bold tracking-tight ${verdict === "hold" ? "text-kumo-danger" : verdict === "ready" ? "text-kumo-success" : "text-kumo-inactive"}`}
                >
                  {verdict === null
                    ? "…"
                    : verdict === "hold"
                      ? "HOLD"
                      : "READY"}
                </div>
              </div>
              <div className="flex gap-2">
                <Badge variant="destructive">{counts.blocker} blockers</Badge>
                <Badge variant="primary">
                  {counts["needs-review"]} needs review
                </Badge>
                <Badge variant="secondary">{counts.info} info</Badge>
              </div>
              <div className="text-xs text-kumo-inactive">
                {state.specId} · {state.bom.length} lines · {state.context?.odm}{" "}
                · need-by {state.context?.needBy}
              </div>
              <div className="flex-1" />
              <StatusSteps status={state.status} />
            </Surface>

            {state.status === "running" && (
              <Text size="sm" variant="secondary">
                Running rule checks and LLM judgment…
              </Text>
            )}
            {state.status === "error" && (
              <Surface className="rounded-xl ring-2 ring-kumo-danger px-4 py-3 text-sm">
                <WarningOctagonIcon size={16} className="inline mr-1" />
                Review failed: {state.error}
              </Surface>
            )}

            <FindingsTable
              findings={live}
              editable={editable}
              drafts={drafts}
              setDraft={(id, d) =>
                setDrafts((all) => ({ ...all, [id]: { ...all[id], ...d } }))
              }
            />

            {editable && (
              <div className="flex items-center gap-2">
                <Button variant="primary" disabled={busy} onClick={submit}>
                  Approve decisions and draft ODM note
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    const reason =
                      prompt(
                        "Reason for rejecting the whole review (for example: ODM must resubmit)?"
                      ) ?? "";
                    run(() => agent.stub.rejectReview(reason));
                  }}
                >
                  Reject review
                </Button>
                <Text size="xs" variant="secondary">
                  The workflow is paused until you decide. Only approved,
                  non-info findings go into the note.
                </Text>
              </div>
            )}

            {(state.status === "complete" ||
              state.status === "rejected" ||
              state.status === "error") && (
              <Button
                variant="secondary"
                disabled={!connected || busy}
                onClick={() =>
                  run(() =>
                    agent.stub.loadDemo(
                      buildId === DEMO_BUILD_IDS.clean ? "clean" : "issues"
                    )
                  )
                }
              >
                Re-run review
              </Button>
            )}

            {state.note && (
              <Surface className="rounded-xl ring ring-kumo-line px-5 py-4 space-y-2">
                <div className="flex items-center gap-2">
                  <Text size="sm" bold>
                    Draft ODM escalation note
                  </Text>
                  <Badge variant="secondary">
                    {state.note.source === "llm"
                      ? `LLM · ${state.note.modelId.split("/").pop()}`
                      : "Template"}
                  </Badge>
                  <div className="flex-1" />
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<CopyIcon size={14} />}
                    onClick={() =>
                      navigator.clipboard.writeText(
                        `${state.note!.subject}\n\n${state.note!.body}`
                      )
                    }
                  >
                    Copy
                  </Button>
                </div>
                <div className="text-sm font-semibold">
                  {state.note.subject}
                </div>
                <pre className="whitespace-pre-wrap text-sm font-sans text-kumo-default">
                  {state.note.body}
                </pre>
              </Surface>
            )}
          </>
        )}

        {state.audit.length > 0 && (
          <details className="rounded-xl ring ring-kumo-line px-4 py-3">
            <summary className="cursor-pointer text-sm font-semibold">
              Audit log ({state.audit.length})
            </summary>
            <ul className="mt-2 space-y-1 text-xs font-mono">
              {[...state.audit].reverse().map((a, i) => (
                <li key={i}>
                  <span className="text-kumo-inactive">
                    {new Date(a.at).toLocaleString()}
                  </span>{" "}
                  [{a.actor}] {a.action}
                  {a.detail ? ` · ${a.detail}` : ""}
                </li>
              ))}
            </ul>
          </details>
        )}
      </main>
      <aside className="w-[24rem] border-l border-kumo-line bg-kumo-base hidden lg:flex flex-col">
        <ChatPanel agent={agent} connected={connected} />
      </aside>
    </div>
  );
}

// ── Upload ────────────────────────────────────────────────────────────

const UPLOAD_FIELDS: {
  key: keyof RawReviewFiles;
  label: string;
  accept: string;
}[] = [
  { key: "spec", label: "spec.json", accept: ".json" },
  { key: "bom", label: "bom.csv", accept: ".csv" },
  { key: "certs", label: "certs.csv", accept: ".csv" },
  { key: "context", label: "context.json", accept: ".json" }
];

function UploadForm({
  onReady,
  onCancel
}: {
  onReady: (buildId: string, files: RawReviewFiles) => void;
  onCancel: () => void;
}) {
  const [files, setFiles] = useState<Partial<RawReviewFiles>>({});
  const [error, setError] = useState("");
  const ready = UPLOAD_FIELDS.every((f) => files[f.key]);
  return (
    <Surface className="rounded-xl ring ring-kumo-line px-5 py-4 space-y-3 m-6">
      <Text size="sm" bold>
        Upload a review package
      </Text>
      <Text size="xs" variant="secondary">
        Formats match the files in <code>demo/</code>. The build ID in
        context.json names the review.
      </Text>
      <div className="grid grid-cols-2 gap-3">
        {UPLOAD_FIELDS.map((f) => (
          <label key={f.key} className="text-xs space-y-1">
            <div>{f.label}</div>
            <input
              type="file"
              accept={f.accept}
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const text = await file.text();
                setFiles((all) => ({ ...all, [f.key]: text }));
              }}
            />
          </label>
        ))}
      </div>
      {error && <div className="text-sm text-kumo-danger">{error}</div>}
      <div className="flex gap-2">
        <Button
          variant="primary"
          disabled={!ready}
          onClick={() => {
            try {
              const buildId = String(JSON.parse(files.context!).buildId ?? "");
              if (!/^[A-Za-z0-9-]+$/.test(buildId))
                throw new Error(
                  "context.json needs a buildId (letters, digits, dashes)"
                );
              onReady(buildId, files as RawReviewFiles);
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            }
          }}
        >
          Start review
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Surface>
  );
}

// ── Shell ─────────────────────────────────────────────────────────────

function Shell() {
  const [buildId, setBuildId] = useState<string>(DEMO_BUILD_IDS.issues);
  const [uploading, setUploading] = useState(false);
  const [pending, setPending] = useState<RawReviewFiles | null>(null);
  const clearPending = useCallback(() => setPending(null), []);

  const demoButton = (name: DemoName, label: string) => (
    <Button
      size="sm"
      variant={
        buildId === DEMO_BUILD_IDS[name] && !uploading ? "primary" : "secondary"
      }
      onClick={() => {
        setUploading(false);
        setBuildId(DEMO_BUILD_IDS[name]);
      }}
    >
      {label}
    </Button>
  );

  return (
    <div className="flex flex-col h-screen bg-kumo-elevated">
      <header className="px-6 py-3 bg-kumo-base border-b border-kumo-line flex items-center gap-3 flex-wrap">
        <h1 className="text-lg font-semibold text-kumo-default">
          Rack BOM Review Agent
        </h1>
        <Badge variant="secondary">synthetic data</Badge>
        <div className="flex-1" />
        {demoButton("issues", "Demo: 6 planted issues")}
        {demoButton("clean", "Demo: clean BOM")}
        <Button
          size="sm"
          variant={uploading ? "primary" : "secondary"}
          icon={<UploadSimpleIcon size={14} />}
          onClick={() => setUploading(true)}
        >
          Upload
        </Button>
        <ThemeToggle />
      </header>
      {uploading ? (
        <UploadForm
          onCancel={() => setUploading(false)}
          onReady={(id, files) => {
            setUploading(false);
            setPending(files);
            setBuildId(id);
          }}
        />
      ) : (
        <Workspace
          key={buildId}
          buildId={buildId}
          pendingFiles={pending}
          onPendingHandled={clearPending}
        />
      )}
      <div className="flex justify-center py-2 border-t border-kumo-line">
        <PoweredByCloudflare href="https://developers.cloudflare.com/agents/" />
      </div>
    </div>
  );
}

export default function App() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-screen text-kumo-inactive">
          Loading...
        </div>
      }
    >
      <Shell />
    </Suspense>
  );
}
