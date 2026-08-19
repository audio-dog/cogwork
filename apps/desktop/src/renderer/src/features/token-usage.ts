import type { RunSummary } from "@cogwork/contracts";

export const tokenCountLabel = (usage: RunSummary["usage"]) => {
  const total = usage?.totalTokens;
  if (total === undefined) return null;
  const estimated = usage?.estimated === true;
  return { text: `${estimated ? "~" : ""}${total}`, estimated };
};
