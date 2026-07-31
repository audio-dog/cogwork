export const cursorEfforts = ["none", "low", "medium", "high", "xhigh", "max"] as const;
export type CursorEffort = (typeof cursorEfforts)[number];

export const cursorModels = [
  "auto",
  "composer-2.5",
  "composer-2.5-fast",
  "claude-opus-5-thinking-high",
  "claude-opus-5-thinking-medium",
  "claude-opus-5-thinking-low",
  "claude-opus-4-8",
  "claude-opus-4-8-thinking-high",
  "claude-sonnet-5-thinking-high",
  "claude-sonnet-5-thinking-medium",
  "gpt-5.6-sol-high",
  "gpt-5.6-terra-medium",
  "gpt-5.5-high",
  "gpt-5.3-codex",
  "gpt-5.2",
  "cursor-grok-4.5-high",
  "kimi-k3-high",
] as const;
export type CursorModel = (typeof cursorModels)[number];

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

export const applyCursorEffort = (model: string, effort: string | null | undefined) => {
  if (!effort) return model;
  const match = model.match(/^([^[\]]+)\[(.*)\]$/);
  const base = match?.[1];
  const inner = match?.[2];
  if (!base || inner === undefined) return `${model}[effort=${effort}]`;
  const params = inner
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith("effort="));
  return `${base}[${[...params, `effort=${effort}`].join(",")}]`;
};

export const cursorModelFlag = (model: string, effort: string | null | undefined) =>
  shellQuote(applyCursorEffort(model, effort));
