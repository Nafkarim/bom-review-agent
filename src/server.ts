import { callable, routeAgentRequest, type Connection } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { convertToModelMessages, streamText } from "ai";
import { availableModels, defaultModelId, getModel } from "./config";
import { DEMOS, type DemoName } from "./demo";
import { IntakeError, parseReviewInput, type RawReviewFiles } from "./parse";
import { severityCounts, verdict } from "./rules";
import type {
  AuditEntry,
  Finding,
  FindingDecision,
  ReviewState,
  UsageRecord
} from "./types";
import { makeUsageRecord } from "./usage";

export { ReviewWorkflow } from "./workflow";

type AgentEnv = Env & { ANTHROPIC_API_KEY?: string };

const MAX_AUDIT = 200;
const MAX_USAGE = 500;

export type StartResult = { ok: true } | { ok: false; problems: string[] };

/** One instance per review, named by build ID. All review state lives here (SQLite-backed). */
export class ReviewAgent extends AIChatAgent<AgentEnv, ReviewState> {
  maxPersistedMessages = 100;

  initialState: ReviewState = {
    context: null,
    specId: null,
    bom: [],
    status: "idle",
    verdict: null,
    findings: [],
    workflowId: null,
    modelId: "",
    note: null,
    audit: [],
    usage: [],
    error: null
  };

  onStart() {
    if (!this.state.modelId) this.patch({ modelId: defaultModelId(this.env) });
  }

  // Clients get state broadcasts but cannot write state; every change goes through a method below.
  validateStateChange(_next: ReviewState, source: Connection | "server") {
    if (source !== "server")
      throw new Error("Review state is read-only for clients");
  }

  private patch(partial: Partial<ReviewState>, audit?: Omit<AuditEntry, "at">) {
    const entries = audit
      ? [...this.state.audit, { at: new Date().toISOString(), ...audit }]
      : this.state.audit;
    this.setState({
      ...this.state,
      ...partial,
      audit: entries.slice(-MAX_AUDIT)
    });
  }

  // ── Client-callable ────────────────────────────────────────────────

  @callable()
  listModels() {
    return availableModels(this.env).map(({ id, label, requires }) => ({
      id,
      label,
      requires
    }));
  }

  @callable()
  setModel(modelId: string) {
    const entry = availableModels(this.env).find((m) => m.id === modelId);
    if (!entry)
      throw new Error(`Model ${modelId} is not available in this deployment`);
    if (entry.id === this.state.modelId) return;
    this.patch(
      { modelId: entry.id },
      { actor: "reviewer", action: "Changed model", detail: entry.label }
    );
  }

  @callable()
  async loadDemo(name: DemoName): Promise<StartResult> {
    const files = DEMOS[name];
    if (!files) return { ok: false, problems: [`Unknown demo ${name}`] };
    return this.startReview(files);
  }

  @callable()
  async startReview(files: RawReviewFiles): Promise<StartResult> {
    let input;
    try {
      input = parseReviewInput(files);
    } catch (e) {
      if (e instanceof IntakeError) return { ok: false, problems: e.problems };
      throw e;
    }
    if (input.context.buildId !== this.name) {
      return {
        ok: false,
        problems: [
          `context.json buildId ${input.context.buildId} does not match this review (${this.name})`
        ]
      };
    }
    if (this.state.status === "running" || this.state.status === "drafting") {
      return {
        ok: false,
        problems: [
          "A review is already running; wait for it to reach the approval step."
        ]
      };
    }
    if (this.state.status === "awaiting-approval" && this.state.workflowId) {
      await this.rejectWorkflow(this.state.workflowId, {
        reason: "Superseded by a new submission"
      }).catch(() => {});
    }

    const modelId = this.state.modelId || defaultModelId(this.env);
    this.patch(
      {
        context: input.context,
        specId: `${input.spec.specId} rev ${input.spec.revision}`,
        bom: input.bom,
        status: "running",
        verdict: null,
        findings: [],
        note: null,
        error: null,
        workflowId: null
      },
      {
        actor: "system",
        action: "Review started",
        detail: `${input.bom.length} BOM lines, model ${modelId}`
      }
    );
    const workflowId = await this.runWorkflow("REVIEW_WORKFLOW", {
      files,
      modelId
    });
    this.patch({ workflowId });
    return { ok: true };
  }

  /** Records the reviewer's decision on every finding, then resumes the workflow to draft the note. */
  @callable()
  async submitDecisions(decisions: FindingDecision[]) {
    const { status, workflowId, findings } = this.state;
    if (status !== "awaiting-approval" || !workflowId)
      throw new Error("No review is waiting for approval");
    const byId = new Map(decisions.map((d) => [d.id, d]));
    const missing = findings.filter((f) => !byId.has(f.id)).map((f) => f.id);
    if (missing.length > 0)
      throw new Error(
        `Decide every finding first (missing ${missing.join(", ")})`
      );

    const edited: string[] = [];
    const updated: Finding[] = findings.map((f) => {
      const d = byId.get(f.id)!;
      const next: Finding = {
        ...f,
        status: d.status,
        severity: d.severity ?? f.severity,
        suggestedAction: d.suggestedAction?.trim() || f.suggestedAction,
        reviewerNote: d.reviewerNote?.trim() || undefined
      };
      if (
        next.severity !== f.severity ||
        next.suggestedAction !== f.suggestedAction ||
        next.reviewerNote
      ) {
        edited.push(f.id);
      }
      return next;
    });
    const approved = updated.filter((f) => f.status === "approved").length;
    this.patch(
      { findings: updated, verdict: verdict(updated), status: "drafting" },
      {
        actor: "reviewer",
        action: "Approved findings",
        detail: `${approved} approved, ${updated.length - approved} rejected${edited.length ? `, edited ${edited.join(", ")}` : ""}; verdict ${verdict(updated).toUpperCase()}`
      }
    );
    await this.approveWorkflow(workflowId, {
      reason: "Reviewer approved findings",
      metadata: { approved }
    });
  }

  @callable()
  async rejectReview(reason: string) {
    const { status, workflowId } = this.state;
    if (status !== "awaiting-approval" || !workflowId)
      throw new Error("No review is waiting for approval");
    this.patch(
      { status: "rejected" },
      {
        actor: "reviewer",
        action: "Rejected review",
        detail: reason || "No reason given"
      }
    );
    await this.rejectWorkflow(workflowId, {
      reason: reason || "Rejected by reviewer"
    });
  }

  // ── Workflow RPC (not exposed to clients) ──────────────────────────

  async applyWorkflowUpdate(
    partial: Partial<ReviewState>,
    action: string,
    detail?: string
  ) {
    this.patch(partial, { actor: "system", action, detail });
  }

  async recordUsage(record: UsageRecord) {
    this.patch({ usage: [...this.state.usage, record].slice(-MAX_USAGE) });
  }

  async getFindings(): Promise<Finding[]> {
    return this.state.findings;
  }

  async onWorkflowError(
    _workflowName: string,
    _instanceId: string,
    error: string
  ) {
    if (this.state.status === "rejected") return;
    this.patch(
      { status: "error", error },
      { actor: "system", action: "Workflow failed", detail: error }
    );
  }

  // ── Chat ───────────────────────────────────────────────────────────

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const { entry, model } = getModel(this.env, this.state.modelId);
    const started = Date.now();

    // No tools: the whole review (about 2k tokens) goes in the system prompt.
    // Tool calling on smaller Workers AI models looped or leaked call JSON as text,
    // and grounding by context works the same on every model in the picker.
    const result = streamText({
      model,
      system: this.chatSystemPrompt(),
      messages: await convertToModelMessages(this.messages),
      abortSignal: options?.abortSignal,
      onFinish: ({ totalUsage }) => {
        this.recordUsage(
          makeUsageRecord({
            source: "chat",
            modelId: entry.id,
            inputTokens: totalUsage.inputTokens,
            outputTokens: totalUsage.outputTokens,
            ms: Date.now() - started
          })
        );
      }
    });
    return result.toUIMessageStreamResponse();
  }

  private chatSystemPrompt(): string {
    const s = this.state;
    if (!s.context) {
      return "You are a BOM review assistant. No review has been run yet; tell the user to load a demo BOM or upload files.";
    }
    const counts = severityCounts(s.findings);
    const findings = s.findings
      .map(
        (f) =>
          `${f.id} [${f.severity}${f.status !== "pending" ? `, ${f.status}` : ""}] ${f.line === null ? "rack" : `line ${f.line}`} ${f.partNumber} ${f.category}: expected ${f.expected}; found ${f.found}. ${f.evidence} (source: ${f.source === "llm" ? `LLM ${f.modelId}` : "rule check in code"})${f.reviewerNote ? ` Reviewer note: ${f.reviewerNote}` : ""}`
      )
      .join("\n");
    const bom = s.bom
      .map(
        (l) =>
          `line ${l.line}: ${l.partNumber} | ${l.description} | ${l.manufacturer} | qty ${l.quantity} | rev ${l.revision || "-"} | lead ${l.leadTimeDays ?? "-"}d | cert ${l.certRef || "-"}`
      )
      .join("\n");
    return `You are a BOM review assistant for a rack integration engineer.
Answer only from the review data below. Always cite BOM line numbers (for example "line 14") and finding IDs.
If the data does not answer the question, say so; never invent parts, quantities or dates.
Exact checks (revision, quantity, vendor, cert, lead time, power) were done by code; you only explain them.
Be concise: short paragraphs or a bulleted list.

Build ${s.context.buildId}, ODM ${s.context.odm}, spec ${s.specId}, need-by ${s.context.needBy}, ${s.bom.length} BOM lines.
Status: ${s.status}. Verdict: ${s.verdict?.toUpperCase() ?? "pending"}. Blockers ${counts.blocker}, needs review ${counts["needs-review"]}, info ${counts.info}.
Findings:
${findings || "(none yet)"}

Submitted BOM:
${bom}`;
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
