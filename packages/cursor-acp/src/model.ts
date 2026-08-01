export const cursorEfforts = ["none", "low", "medium", "high", "xhigh", "max"] as const;
export type CursorEffort = (typeof cursorEfforts)[number];

export const parseCursorModelList = (output: string) =>
  output.split("\n").flatMap((line) => {
    const id = line.trim().match(/^(\S+) - \S/)?.[1];
    return id ? [id] : [];
  });

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
