import { codexCatalog } from "./models.generated";

export const codexNativeEffort = (modelId: string, selected: string | null) => {
  const model = codexCatalog.models.find(({ value }) => value === modelId);
  const descriptor = model?.options.find(({ id }) => id === "effort");
  const selection = selected ?? descriptor?.defaultValue;
  const effort = descriptor?.values.find(({ value }) => value === selection)?.value;
  const hasNativeEffort = effort !== undefined;
  if (hasNativeEffort) return effort;
  throw new Error(`unsupported Codex reasoning effort: ${selection}`);
};
