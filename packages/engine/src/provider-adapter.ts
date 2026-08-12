import type { AnyTextAdapter } from "@tanstack/ai/adapters";
import { ANTHROPIC_MODELS, createAnthropicChat } from "@tanstack/ai-anthropic";
import { createGeminiChat, GEMINI_MODELS } from "@tanstack/ai-gemini";
import { createOpenaiChat, OPENAI_CHAT_MODELS } from "@tanstack/ai-openai";
import * as Redacted from "effect/Redacted";

// Only providers whose model lists ship as literal-union constants are wired here,
// so a config model string matches the real list and builds a typed adapter with
// no cast. OpenRouter has no such constant; a host adds it via `makeAdapter`.
export type ProviderId = "openai" | "anthropic" | "google";

const providerIds: ReadonlyArray<ProviderId> = ["openai", "anthropic", "google"];

const asProviderId = (value: string) => providerIds.find((id) => id === value) ?? null;

export interface ResolvedModel {
  readonly provider: ProviderId;
  readonly model: string;
}

export const parseModelRef = (raw: string): ResolvedModel | null => {
  const slash = raw.indexOf("/");
  if (slash <= 0) return null;
  const provider = asProviderId(raw.slice(0, slash));
  return provider === null ? null : { provider, model: raw.slice(slash + 1) };
};

export type ModelAdapterFactory = (
  resolved: ResolvedModel,
  apiKey: Redacted.Redacted<string>,
) => AnyTextAdapter | null;

const pick = <Model extends string>(
  models: ReadonlyArray<Model>,
  model: string,
  build: (model: Model) => AnyTextAdapter,
) => {
  const match = models.find((candidate) => candidate === model);
  return match === undefined ? null : build(match);
};

// The only place the key is unwrapped: it flows into the provider SDK client the
// adapter holds and never reaches messages or events.
export const defaultModelAdapterFactory: ModelAdapterFactory = (resolved, apiKey) => {
  const key = Redacted.value(apiKey);
  if (resolved.provider === "openai") {
    return pick(OPENAI_CHAT_MODELS, resolved.model, (model) => createOpenaiChat(model, key));
  }
  if (resolved.provider === "anthropic") {
    return pick(ANTHROPIC_MODELS, resolved.model, (model) => createAnthropicChat(model, key));
  }
  return pick(GEMINI_MODELS, resolved.model, (model) => createGeminiChat(model, key));
};
