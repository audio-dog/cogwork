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

export const variantKeys = ["A", "B", "C", "D", "E"] as const;

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
    name: "Cards, checkbox",
    claim:
      "The reference. Filling cards with a checkbox in each corner — the shape that works, with the control that reads as busy because the fill already says what the box says.",
  },
  {
    key: "B",
    name: "Cards, pressed",
    claim:
      "The card is the control, the way the theme tiles in Settings already work. A check appears only when it is on: one glyph, and only in the state that needs confirming.",
  },
  {
    key: "C",
    name: "Cards, dimmed",
    claim:
      "No glyph at all. A card that is on is simply present; one that is off recedes. Quietest of the four, and the one that asks a reader to notice contrast rather than read a mark.",
  },
  {
    key: "D",
    name: "Plain rows",
    claim:
      "The control: the header and the place rows at their natural height, and nothing else. No cards, no filling, no glyph beyond the checkbox.",
  },
  {
    key: "E",
    name: "Cards, show/hide",
    claim:
      "An eye rather than a checkbox, because this menu is a filter: unchecking a box does not deselect a place, it hides it. Smaller glyph than a checkbox, and it names the actual verb.",
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
