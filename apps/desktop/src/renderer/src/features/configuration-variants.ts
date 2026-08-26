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
    name: "Footer bar",
    claim:
      "Two panes with a bottom edge. A footer spans both, bounding the right pane's leftover space and housing select all and select none — out of the trigger, where they were doing nothing.",
  },
  {
    key: "B",
    name: "Peer list",
    claim:
      "User stops being a header and becomes the first row, same shape as every workspace, so the panes stop looking like two designs. Each place is a card that grows to fill the pane.",
  },
  {
    key: "C",
    name: "Preview",
    claim:
      "The empty space gets filled with information instead of layout: under each place sits what actually lives there. A count says how many; this says which.",
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
