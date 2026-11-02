// Durable review pipeline: intake -> rules -> LLM judgment -> human approval -> ODM note.
// Each step.do result is persisted, so a retry or restart never re-runs a finished step
// (and never double-counts LLM usage).
import {
  AgentWorkflow,
  type AgentWorkflowEvent,
  type AgentWorkflowStep
} from "agents/workflows";
import { draftEscalation, judgeSubstitutions } from "./llm";
import { parseReviewInput, type RawReviewFiles } from "./parse";
import { finalizeFindings, runRules, verdict, type Judgment } from "./rules";
import type { ReviewAgent } from "./server";

export type ReviewParams = { files: RawReviewFiles; modelId: string };

const NO_RETRY = { retries: { limit: 0, delay: 0 } } as const;
const LLM_RETRY = {
  retries: { limit: 1, delay: "5 seconds" },
  timeout: "3 minutes"
} as const;

export class ReviewWorkflow extends AgentWorkflow<ReviewAgent, ReviewParams> {
  async run(event: AgentWorkflowEvent<ReviewParams>, step: AgentWorkflowStep) {
    const { files, modelId } = event.payload;

    // Intake was already validated by the agent before starting; this re-parse is deterministic.
    const input = await step.do("intake", NO_RETRY, async () =>
      parseReviewInput(files)
    );

    const unresolved = await step.do("rules", NO_RETRY, async () => {
      const { unresolved } = runRules(input);
      await this.agent.applyWorkflowUpdate(
        {},
        `Line checks done in code; ${unresolved.length} off-spec line(s) need LLM judgment`
      );
      return unresolved;
    });

    const judgments = await step.do(
      "llm-judge",
      LLM_RETRY,
      async (): Promise<Judgment[]> => {
        if (unresolved.length === 0) return [];
        const res = await judgeSubstitutions(this.env, modelId, unresolved);
        if (res.usage) await this.agent.recordUsage(res.usage);
        await this.agent.applyWorkflowUpdate(
          {},
          res.error
            ? `LLM judgment unavailable (${res.usage?.modelId ?? modelId}); ${unresolved.length} line(s) sent to reviewer`
            : `LLM judged ${res.judgments.length} line(s) with ${res.usage?.modelId ?? modelId}`,
          res.error
        );
        return res.judgments;
      }
    );

    await step.do("publish-findings", NO_RETRY, async () => {
      const findings = finalizeFindings(
        input,
        runRules(input),
        new Map(judgments.map((j) => [j.line, j]))
      );
      await this.agent.applyWorkflowUpdate(
        { findings, verdict: verdict(findings), status: "awaiting-approval" },
        `Findings ready for review: ${findings.length} total, verdict ${verdict(findings).toUpperCase()}`
      );
    });

    await this.reportProgress({
      step: "approval",
      status: "pending",
      message: "Waiting for reviewer approval"
    });
    // Throws WorkflowRejectedError if the reviewer rejects the review; the agent records that.
    await this.waitForApproval(step, { timeout: "7 days" });

    await step.do("draft-note", LLM_RETRY, async () => {
      const findings = await this.agent.getFindings();
      const res = await draftEscalation(
        this.env,
        modelId,
        input.context,
        findings
      );
      if (res.usage) await this.agent.recordUsage(res.usage);
      await this.agent.applyWorkflowUpdate(
        { note: res.note, status: "complete" },
        res.note.source === "llm"
          ? `Escalation note drafted by ${res.note.modelId}`
          : "Escalation note built from template (model not used or unavailable)",
        res.error
      );
    });

    await step.reportComplete({ ok: true });
  }
}
