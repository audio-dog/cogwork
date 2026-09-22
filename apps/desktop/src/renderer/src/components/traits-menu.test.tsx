import { type HarnessCatalogChoice, HarnessName, HarnessOptionCatalog } from "@cogwork/contracts";
import * as Schema from "effect/Schema";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { HarnessCatalog, ModelOptionState } from "../features/operation-settings";
import { TraitsMenu } from "./traits-menu";

const model = {
  value: "model-a",
  label: "Model A",
  options: [
    {
      type: "select",
      id: "effort",
      label: "Effort",
      values: [
        { value: "low", label: "Low" },
        { value: "high", label: "High" },
      ],
      defaultValue: "high",
    },
    { type: "boolean", id: "speed", label: "Speed", defaultValue: false },
  ],
} satisfies HarnessCatalogChoice;

const catalog = {
  ...HarnessOptionCatalog.make({
    models: [model],
    policyProfiles: ["full"],
    provenance: { source: "managed" },
  }),
  harness: Schema.decodeSync(HarnessName)("cursor"),
} satisfies HarnessCatalog;

const options = [
  { descriptor: model.options[0], value: "high", source: "inherited" },
  { descriptor: model.options[1], value: false, source: "default" },
] satisfies ReadonlyArray<ModelOptionState>;

describe("TraitsMenu", () => {
  it("summarizes inherited and default descriptor values", () => {
    const markup = renderToStaticMarkup(
      <TraitsMenu
        state={{ catalog, model, options }}
        actions={{ select: vi.fn() }}
        meta={{ disabled: false }}
      />,
    );

    expect(markup).toContain('aria-label="Traits: High (inherited) · Speed Off (default)"');
    expect(markup).toContain('data-source="inherited"');
    expect(markup).toContain('data-source="default"');
    expect(markup).toContain("italic");
  });

  it("surfaces a stale selection instead of presenting its fallback as selected", () => {
    const staleOptions = [
      {
        descriptor: model.options[0],
        value: "high",
        source: "stale",
        staleValue: "retired",
      },
    ] satisfies ReadonlyArray<ModelOptionState>;
    const markup = renderToStaticMarkup(
      <TraitsMenu
        state={{ catalog, model, options: staleOptions }}
        actions={{ select: vi.fn() }}
        meta={{ disabled: false }}
      />,
    );

    expect(markup).toContain('aria-label="Traits: Effort: retired (stale)"');
    expect(markup).toContain('data-source="stale"');
    expect(markup).toContain("text-destructive");
  });

  it("renders nothing for a model without descriptors", () => {
    const markup = renderToStaticMarkup(
      <TraitsMenu
        state={{ catalog, model: { value: "plain", label: "Plain" }, options: [] }}
        actions={{ select: vi.fn() }}
        meta={{ disabled: false }}
      />,
    );

    expect(markup).toBe("");
  });
});
