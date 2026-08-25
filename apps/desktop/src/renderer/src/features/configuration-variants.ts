// PROTOTYPE — the variant registry for the Customize page.
//
// The question these three answer is narrow and deliberate: **how does a person see the filter
// axes, and swap between them?** Everything else on the page is held constant so the comparison is
// about that and nothing else.
//
// There are three axes, not two, and noticing the third is half the problem:
//   1. Contribution kind — six values, plus Plugins as a grouping over them.
//   2. Scope — three rungs, and a *ladder* rather than a flat set, so "filtering" by it is a
//      category error: a filter says what is visible, a ladder says what won.
//   3. Workspace — two of the three Scopes are workspace-bound, so a Scope is not fully named
//      until a workspace is.

export const variantKeys = ["A", "B", "C"] as const;

export type VariantKey = (typeof variantKeys)[number];

export interface VariantDefinition {
  readonly key: VariantKey;
  readonly name: string;
  /** The claim, shown in the switcher so a reader knows what to judge. */
  readonly claim: string;
}

export const variants: readonly VariantDefinition[] = [
  {
    key: "A",
    name: "Matrix",
    claim:
      "One row per workspace and two aligned checkbox columns. Nothing is nested, so nothing needs revealing — and the column headings toggle every workspace's repo, or every private overlay, at once.",
  },
  {
    key: "B",
    name: "Two panes",
    claim:
      "Workspaces on the left, that workspace's places on the right. Browsing costs no clicks — the pointer alone reveals each one — and it is the only shape that still works at twenty workspaces.",
  },
  {
    key: "C",
    name: "Segmented rows",
    claim:
      "One row per workspace, its two places as chips on the right carrying their own state and count. The most compact and the least abstract, at the cost of any whole-column action.",
  },
];

export function isVariantKey(value: unknown): value is VariantKey {
  return typeof value === "string" && variantKeys.includes(value as VariantKey);
}

export const defaultVariant: VariantKey = "A";

export function findVariant(key: VariantKey): VariantDefinition {
  return variants.find((variant) => variant.key === key) ?? variants[0];
}

export function nextVariant(key: VariantKey, step: 1 | -1): VariantKey {
  const index = variantKeys.indexOf(key);
  return variantKeys[(index + step + variantKeys.length) % variantKeys.length];
}
