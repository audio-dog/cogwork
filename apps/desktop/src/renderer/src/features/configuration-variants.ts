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
    name: "Cards that fill",
    claim:
      "The right pane answers its leftover space with geometry: each place takes an equal share of the height. Cheapest, and the only one that cannot scroll — but a bigger card tells you nothing new.",
  },
  {
    key: "B",
    name: "Preview",
    claim:
      "The space fills with information — under each place, what actually lives there. A count says three Skills are in the repo; this says one of them is the one you were looking for.",
  },
  {
    key: "C",
    name: "Detail pane",
    claim:
      "Stops treating the space as a gap. Places sit at their natural height and a summary pins to the bottom, carrying the tracker, the shared-remote warning, and a tally across every kind rather than just the filtered one.",
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
