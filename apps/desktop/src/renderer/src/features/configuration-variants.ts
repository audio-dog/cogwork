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

export const variantKeys = ["A", "B", "C", "D"] as const;

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
    name: "Two rows",
    claim:
      "Kept as the reference point. Kind filters; Scope names the write target and every row carries the whole ladder. The level switch is still a mode, which is what the other three try to remove.",
  },
  {
    key: "B",
    name: "Layer rail",
    claim:
      "The mode gets a place to live. Three stacked layer cards down the left, each carrying its name, what it means, how much is written there, and how much of it wins. Switching is one click on a thing you can always see.",
  },
  {
    key: "C",
    name: "Three columns",
    claim:
      "No mode at all. One column per level, side by side, so the ladder is taught by the layout itself. Every cell is always editable, and swapping levels means moving your cursor.",
  },
  {
    key: "D",
    name: "Effective first",
    claim:
      "One switch per row and a chip saying where the value came from. The three levels stay out of the way until a row is opened, so the common case never asks about them at all.",
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
