import { describe, expect, it } from "vitest";
import { availableModels, MODELS, resolveModel } from "../src/config";
import { estimateCostUsd, makeUsageRecord, summarizeUsage } from "../src/usage";

const LLAMA = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const SCOUT = "@cf/meta/llama-4-scout-17b-16e-instruct";

describe("model registry", () => {
  it("hides Anthropic without a key and shows it with one", () => {
    expect(availableModels({}).some((m) => m.provider === "anthropic")).toBe(
      false
    );
    expect(
      availableModels({ ANTHROPIC_API_KEY: "x" }).some(
        (m) => m.provider === "anthropic"
      )
    ).toBe(true);
  });

  it("falls back to the deployment default for unknown or unavailable ids", () => {
    expect(resolveModel({ DEFAULT_MODEL: SCOUT }, "@cf/made-up/model").id).toBe(
      SCOUT
    );
    expect(resolveModel({ DEFAULT_MODEL: SCOUT }, "claude-opus-5-5").id).toBe(
      SCOUT
    );
    expect(resolveModel({}, null).id).toBe(LLAMA);
    expect(resolveModel({ DEFAULT_MODEL: "nonsense" }, null).id).toBe(LLAMA);
  });

  it("honours a valid selection", () => {
    expect(
      resolveModel({ ANTHROPIC_API_KEY: "x" }, "claude-opus-5-5").provider
    ).toBe("anthropic");
  });

  it("has unique ids and a price for every model", () => {
    expect(new Set(MODELS.map((m) => m.id)).size).toBe(MODELS.length);
    expect(
      MODELS.every((m) => m.pricePerMInput > 0 && m.pricePerMOutput > 0)
    ).toBe(true);
  });
});

describe("usage meter", () => {
  it("estimates cost from per-million prices", () => {
    // 1M in at $0.293 + 1M out at $2.253
    expect(estimateCostUsd(LLAMA, 1_000_000, 1_000_000)).toBeCloseTo(2.546, 6);
    expect(estimateCostUsd("unknown", 1000, 1000)).toBe(0);
  });

  it("treats missing token counts as zero", () => {
    const r = makeUsageRecord({
      source: "chat",
      modelId: LLAMA,
      inputTokens: undefined,
      outputTokens: 10,
      ms: 5.4
    });
    expect(r).toMatchObject({ inputTokens: 0, outputTokens: 10, ms: 5 });
  });

  it("summarizes by model and by source", () => {
    const records = [
      makeUsageRecord({
        source: "judge",
        modelId: LLAMA,
        inputTokens: 1000,
        outputTokens: 200,
        ms: 1
      }),
      makeUsageRecord({
        source: "draft",
        modelId: LLAMA,
        inputTokens: 500,
        outputTokens: 300,
        ms: 1
      }),
      makeUsageRecord({
        source: "chat",
        modelId: SCOUT,
        inputTokens: 2000,
        outputTokens: 100,
        ms: 1
      })
    ];
    const s = summarizeUsage(records);
    expect(s.total).toMatchObject({
      calls: 3,
      inputTokens: 3500,
      outputTokens: 600
    });
    expect(s.byModel[LLAMA].calls).toBe(2);
    expect(s.byModel[SCOUT].inputTokens).toBe(2000);
    expect(s.bySource.chat.calls).toBe(1);
    expect(s.total.estCostUsd).toBeCloseTo(
      records.reduce((a, r) => a + r.estCostUsd, 0),
      10
    );
  });
});
