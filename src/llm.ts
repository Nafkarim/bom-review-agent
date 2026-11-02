// The only two places the review pipeline uses an LLM: judging off-spec lines
// and writing the ODM note. Both return JSON validated with zod, and both have
// a code fallback so a weak or unavailable model never breaks a review.
import { generateText } from "ai";
import { z } from "zod";
import { getModel } from "./config";
import type { Judgment, UnresolvedLine } from "./rules";
import type {
  BuildContext,
  EscalationNote,
  Finding,
  UsageRecord
} from "./types";
import { makeUsageRecord } from "./usage";

type LlmEnv = { AI: Ai; DEFAULT_MODEL?: string; ANTHROPIC_API_KEY?: string };

const TIMEOUT_MS = 60_000;

/** Pulls the first JSON object out of a reply, tolerating code fences or chatter around it. */
export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start)
    throw new Error("no JSON object in model reply");
  return JSON.parse(text.slice(start, end + 1));
}

async function callJson<T>(
  env: LlmEnv,
  modelId: string,
  source: UsageRecord["source"],
  schema: z.ZodType<T>,
  system: string,
  prompt: string,
  maxOutputTokens: number
): Promise<{
  value: T | null;
  usage: UsageRecord | null;
  modelId: string;
  error?: string;
}> {
  const { entry, model } = getModel(env, modelId);
  const started = Date.now();
  try {
    const res = await generateText({
      model,
      system,
      prompt,
      maxOutputTokens,
      abortSignal: AbortSignal.timeout(TIMEOUT_MS)
    });
    const usage = makeUsageRecord({
      source,
      modelId: entry.id,
      inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens,
      ms: Date.now() - started
    });
    const parsed = schema.safeParse(extractJson(res.text));
    if (!parsed.success)
      return {
        value: null,
        usage,
        modelId: entry.id,
        error: parsed.error.message
      };
    return { value: parsed.data, usage, modelId: entry.id };
  } catch (e) {
    return { value: null, usage: null, modelId: entry.id, error: String(e) };
  }
}

const judgmentSchema = z.object({
  judgments: z.array(
    z.object({
      line: z.number().int(),
      substituteFor: z.string().nullable(),
      risk: z.enum(["low", "medium", "high"]),
      rationale: z.string().min(1).max(600)
    })
  )
});

const JUDGE_SYSTEM = `You review rack Bills of Materials for a data center hardware team.
Some BOM lines use part numbers that are not in the rack spec. For each such line, decide whether it is
a substitution for one of the listed missing spec parts (same function and form factor, different vendor or
part number), or an extra part that is not a substitute for anything.

Risk for a substitution:
- low: same function, form factor and key ratings; only the vendor differs.
- medium: likely compatible but unqualified (new vendor, different revision scheme, unverified ratings).
- high: different ratings, form factor or interface, or the description is too vague to tell.

Reply with ONLY a JSON object, no prose:
{"judgments":[{"line":<number>,"substituteFor":<spec part number or null>,"risk":"low"|"medium"|"high","rationale":"<one or two sentences citing the descriptions>"}]}`;

export async function judgeSubstitutions(
  env: LlmEnv,
  modelId: string,
  unresolved: UnresolvedLine[]
) {
  const candidates = unresolved[0]?.candidates ?? [];
  const prompt = [
    "Missing spec parts (required but no BOM line supplies them):",
    ...candidates.map(
      (c) =>
        `- ${c.partNumber}: ${c.description}; rev ${c.revision}; qty ${c.qtyPerRack}; approved vendor ${c.approvedManufacturers.join(", ")}`
    ),
    "",
    "BOM lines to judge:",
    ...unresolved.map(
      ({ line: l }) =>
        `- line ${l.line}: ${l.partNumber}: ${l.description}; manufacturer ${l.manufacturer}; qty ${l.quantity}; rev ${l.revision}`
    )
  ].join("\n");

  const res = await callJson(
    env,
    modelId,
    "judge",
    judgmentSchema,
    JUDGE_SYSTEM,
    prompt,
    1500
  );
  const asked = new Set(unresolved.map((u) => u.line.line));
  const judgments: Judgment[] = (res.value?.judgments ?? [])
    .filter((j) => asked.has(j.line))
    .map((j) => ({ ...j, modelId: res.modelId }));
  return { judgments, usage: res.usage, error: res.error };
}

const noteSchema = z.object({
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(6000)
});

const NOTE_SYSTEM = `You write concise, professional escalation notes from a rack integration engineer to an ODM.
Use only the findings provided; never invent parts, numbers or dates. Cite every BOM line number.
Group blockers first, then items needing review. Ask for a corrected BOM or specific evidence for each item,
and state the need-by date. Plain text, no markdown tables, under 300 words.
Reply with ONLY a JSON object: {"subject":"...","body":"..."}`;

function describeFinding(f: Finding): string {
  const where = f.line === null ? "rack level" : `line ${f.line}`;
  const note = f.reviewerNote ? ` Reviewer note: ${f.reviewerNote}` : "";
  return `[${f.severity}] ${where}, ${f.partNumber}, ${f.category}: expected ${f.expected}; found ${f.found}. ${f.evidence} Requested action: ${f.suggestedAction}${note}`;
}

/** Findings the ODM must act on: approved, and not merely informational. */
export function escalationFindings(findings: Finding[]): Finding[] {
  return findings.filter(
    (f) => f.status === "approved" && f.severity !== "info"
  );
}

export function templateNote(
  ctx: BuildContext,
  findings: Finding[],
  modelId: string
): EscalationNote {
  const items = escalationFindings(findings);
  const body = [
    `Hello ${ctx.odm} team,`,
    "",
    items.length === 0
      ? `Our review of the BOM for build ${ctx.buildId} found no issues that need action. The build is cleared to proceed.`
      : `Our review of the BOM for build ${ctx.buildId} (spec rev ${ctx.specRevision}) found ${items.length} item(s) that need action before we can release it to integration:`,
    "",
    ...items.map((f, i) => `${i + 1}. ${describeFinding(f)}`),
    "",
    items.length === 0
      ? ""
      : `Please send a corrected BOM or the requested evidence so parts can be on site by ${ctx.needBy}.`,
    "",
    "Thanks,",
    "Rack Integration Operations"
  ].join("\n");
  return {
    subject: `BOM review ${ctx.buildId}: ${items.length === 0 ? "cleared" : `${items.length} item(s) need action`}`,
    body: body.replace(/\n{3,}/g, "\n\n"),
    modelId,
    source: "template",
    createdAt: new Date().toISOString()
  };
}

export async function draftEscalation(
  env: LlmEnv,
  modelId: string,
  ctx: BuildContext,
  findings: Finding[]
) {
  const items = escalationFindings(findings);
  if (items.length === 0)
    return { note: templateNote(ctx, findings, modelId), usage: null };

  const prompt = [
    `Build ${ctx.buildId}, ODM ${ctx.odm}, spec rev ${ctx.specRevision}, need-by ${ctx.needBy}.`,
    "Approved findings:",
    ...items.map((f) => `- ${describeFinding(f)}`)
  ].join("\n");
  const res = await callJson(
    env,
    modelId,
    "draft",
    noteSchema,
    NOTE_SYSTEM,
    prompt,
    1500
  );
  const note: EscalationNote = res.value
    ? {
        ...res.value,
        modelId: res.modelId,
        source: "llm",
        createdAt: new Date().toISOString()
      }
    : templateNote(ctx, findings, res.modelId);
  return { note, usage: res.usage, error: res.error };
}
