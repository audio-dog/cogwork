// PROTOTYPE — the variant registry for #131.
//
// Three structurally different answers to "what should Plugins and Customize look and behave
// like". Each one owns a different set of settings sections, because "one surface or two" is part
// of what is being decided. Switchable with `?variant=`; deleted with the losing variants.

export const variantKeys = ["A", "B", "C"] as const;

export type VariantKey = (typeof variantKeys)[number];

export interface VariantSection {
  readonly id: string;
  readonly label: string;
}

export interface VariantDefinition {
  readonly key: VariantKey;
  readonly name: string;
  /** The claim this variant makes, shown in the switcher so a reader knows what to judge. */
  readonly claim: string;
  readonly sections: readonly VariantSection[];
}

export const variants: readonly VariantDefinition[] = [
  {
    key: "A",
    name: "Facet bar",
    claim:
      "One surface. Plugins is a seventh pill beside the six contribution kinds, and Scope is a multi-select filter that unions what is in view.",
    sections: [
      { id: "plugins", label: "Plugins & contributions" },
      { id: "workspaces", label: "Workspaces" },
    ],
  },
  {
    key: "B",
    name: "Scope spine",
    claim:
      "Two surfaces. Customize puts Scope on the spine, so you always edit exactly one Scope and the cells a Scope may not hold are shown as decisions rather than blanks.",
    sections: [
      { id: "plugins", label: "Plugins" },
      { id: "customize", label: "Customize" },
      { id: "workspaces", label: "Workspaces" },
    ],
  },
  {
    key: "C",
    name: "Operation first",
    claim:
      "Two surfaces, and Customize is an inspector. You start from Workflow to Operation and read what the Run Plan resolves to; Scope appears only as provenance.",
    sections: [
      { id: "plugins", label: "Plugins" },
      { id: "workflows", label: "Workflows" },
      { id: "workspaces", label: "Workspaces" },
    ],
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
  const count = variantKeys.length;
  return variantKeys[(index + step + count) % count];
}
