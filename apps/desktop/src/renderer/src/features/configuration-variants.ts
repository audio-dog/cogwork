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
    name: "Location rail",
    claim:
      "Three equal cards down the left — no indent and no ladder, because these are places a file lives, not rungs. Multi-select: it narrows what is on screen and never decides where a change lands.",
  },
  {
    key: "B",
    name: "Location columns",
    claim:
      "One column per place, and a row sits in the column it lives in. The headings are the filter. When a repository ships something it cannot enable, the marker and the switch land in different columns.",
  },
  {
    key: "C",
    name: "Split dropdown",
    claim:
      "One divided pill inline with the kind filters, and a menu split the same way — machine on top, workspaces below. The only control that can name a workspace and a place in a single click.",
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
