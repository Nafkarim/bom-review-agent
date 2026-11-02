// Usage meter: token counts and estimated cost for every LLM call.
import { MODELS } from "./config";
import type { UsageRecord, UsageSource } from "./types";

export function estimateCostUsd(
  modelId: string,
  inputTokens: number,
  outputTokens: number
): number {
  const m = MODELS.find((x) => x.id === modelId);
  if (!m) return 0;
  return (
    (inputTokens * m.pricePerMInput + outputTokens * m.pricePerMOutput) /
    1_000_000
  );
}

export function makeUsageRecord(args: {
  source: UsageSource;
  modelId: string;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  ms: number;
  at?: Date;
}): UsageRecord {
  const inputTokens = args.inputTokens ?? 0;
  const outputTokens = args.outputTokens ?? 0;
  return {
    at: (args.at ?? new Date()).toISOString(),
    source: args.source,
    modelId: args.modelId,
    inputTokens,
    outputTokens,
    estCostUsd: estimateCostUsd(args.modelId, inputTokens, outputTokens),
    ms: Math.round(args.ms)
  };
}

export type UsageTotals = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  estCostUsd: number;
};

const empty = (): UsageTotals => ({
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  estCostUsd: 0
});

function add(t: UsageTotals, r: UsageRecord) {
  t.calls++;
  t.inputTokens += r.inputTokens;
  t.outputTokens += r.outputTokens;
  t.estCostUsd += r.estCostUsd;
}

export function summarizeUsage(records: UsageRecord[]) {
  const total = empty();
  const byModel: Record<string, UsageTotals> = {};
  const bySource: Record<UsageSource, UsageTotals> = {
    chat: empty(),
    judge: empty(),
    draft: empty()
  };
  for (const r of records) {
    add(total, r);
    add((byModel[r.modelId] ??= empty()), r);
    add(bySource[r.source], r);
  }
  return { total, byModel, bySource };
}
