// The one place model IDs live. Add a model by adding a registry entry.
import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { withDedupedStreams } from "./ai-stream-fix";

export type ModelEntry = {
  id: string;
  label: string;
  provider: "workers-ai" | "anthropic";
  /** Shown in the picker when the model needs more than the free plan. */
  requires?: string;
  /** USD per million tokens, from the provider's pricing page (checked 2026-10-28). */
  pricePerMInput: number;
  pricePerMOutput: number;
};

export const MODELS: ModelEntry[] = [
  {
    id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    label: "Llama 3.3 70B (Workers AI)",
    provider: "workers-ai",
    pricePerMInput: 0.293,
    pricePerMOutput: 2.253
  },
  {
    id: "@cf/meta/llama-4-scout-17b-16e-instruct",
    label: "Llama 4 Scout 17B (Workers AI)",
    provider: "workers-ai",
    pricePerMInput: 0.27,
    pricePerMOutput: 0.85
  },
  {
    id: "@cf/moonshotai/kimi-k2.6",
    label: "Kimi K2.6 (Workers AI)",
    provider: "workers-ai",
    requires: "Workers Paid plan",
    pricePerMInput: 0.95,
    pricePerMOutput: 4.0
  },
  {
    id: "claude-opus-5-5",
    label: "Claude Opus 5.5 (Anthropic)",
    provider: "anthropic",
    requires: "ANTHROPIC_API_KEY secret",
    pricePerMInput: 4.0,
    pricePerMOutput: 20.0
  }
];

export const FALLBACK_MODEL_ID = MODELS[0].id;

type ModelEnv = { AI: Ai; DEFAULT_MODEL?: string; ANTHROPIC_API_KEY?: string };

/** Models usable in this deployment: Anthropic only appears when its key is set. */
export function availableModels(
  env: Pick<ModelEnv, "ANTHROPIC_API_KEY">
): ModelEntry[] {
  return MODELS.filter(
    (m) => m.provider !== "anthropic" || !!env.ANTHROPIC_API_KEY
  );
}

/** Returns the requested model if it exists and is usable here, else the deployment default. */
export function resolveModel(
  env: Pick<ModelEnv, "ANTHROPIC_API_KEY" | "DEFAULT_MODEL">,
  modelId?: string | null
): ModelEntry {
  const usable = availableModels(env);
  return (
    usable.find((m) => m.id === modelId) ??
    usable.find((m) => m.id === env.DEFAULT_MODEL) ??
    usable[0]
  );
}

export function defaultModelId(
  env: Pick<ModelEnv, "ANTHROPIC_API_KEY" | "DEFAULT_MODEL">
): string {
  return resolveModel(env, null).id;
}

export function getModel(
  env: ModelEnv,
  modelId?: string | null
): { entry: ModelEntry; model: LanguageModel } {
  const entry = resolveModel(env, modelId);
  if (entry.provider === "anthropic") {
    return {
      entry,
      model: createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })(entry.id)
    };
  }
  return {
    entry,
    model: createWorkersAI({ binding: withDedupedStreams(env.AI) })(entry.id)
  };
}
