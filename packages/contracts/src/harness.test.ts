import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { HarnessName } from "./base-schemas";
import {
  HarnessEnablement,
  HarnessManagedCatalog,
  HarnessModelOptionDescriptor,
  HarnessOptionCatalog,
  HarnessReadinessItem,
  harnessEnabled,
} from "./harness";

const harness = Schema.decodeSync(HarnessName);

describe("Harness enablement", () => {
  it("defaults a Harness with no stored value to enabled", () => {
    assert.isTrue(harnessEnabled([], harness("codex")));
  });

  it("uses the stored value for that Harness alone", () => {
    const settings = [HarnessEnablement.make({ harness: harness("codex"), enabled: false })];

    assert.isFalse(harnessEnabled(settings, harness("codex")));
    assert.isTrue(harnessEnabled(settings, harness("cursor")));
  });

  it("decodes older Harness reports as enabled", () => {
    const item = Schema.decodeSync(HarnessReadinessItem)({
      harness: "codex",
      version: null,
      state: { _tag: "Ready" },
    });

    assert.isTrue(item.enabled);
  });
});

describe("Harness managed catalog", () => {
  it("decodes select and boolean model option descriptors", () => {
    const decodeDescriptor = Schema.decodeSync(HarnessModelOptionDescriptor);
    const descriptors = [
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
      {
        type: "boolean",
        id: "speed",
        label: "Speed",
        defaultValue: false,
      },
    ] satisfies ReadonlyArray<HarnessModelOptionDescriptor>;

    descriptors.forEach((descriptor) => {
      assert.deepStrictEqual(decodeDescriptor(descriptor), descriptor);
    });

    assert.throws(() =>
      decodeDescriptor({
        type: "select",
        id: "effort",
        label: "Effort",
        values: [{ value: "low", label: "Low" }],
        defaultValue: "high",
      }),
    );
  });

  it("decodes generated catalog metadata and per-model defaults", () => {
    const catalog = Schema.decodeSync(HarnessOptionCatalog)({
      generatedAgainst: "2026.08.11-e8db854",
      rawModelIds: ["auto", "model-high", "model-high-fast"],
      rawModelSelections: {
        auto: { model: "auto", options: {} },
        "model-high": { model: "model", options: { effort: "high", speed: false } },
        "model-high-fast": { model: "model", options: { effort: "high", speed: true } },
      },
      models: [
        { value: "auto", label: "Auto", default: true },
        {
          value: "model",
          label: "Model",
          default: false,
          options: [
            {
              type: "boolean",
              id: "speed",
              label: "Speed",
              defaultValue: false,
            },
          ],
        },
      ],
      policyProfiles: ["full"],
      provenance: { source: "managed" },
    });

    assert.strictEqual(catalog.generatedAgainst, "2026.08.11-e8db854");
    assert.strictEqual(catalog.models[0]?.default, true);
    assert.deepStrictEqual(catalog.rawModelIds, ["auto", "model-high", "model-high-fast"]);
    assert.deepStrictEqual(catalog.rawModelSelections?.["model-high-fast"], {
      model: "model",
      options: { effort: "high", speed: true },
    });
  });

  it("rejects ambiguous model and option identities", () => {
    const decodeCatalog = Schema.decodeSync(HarnessManagedCatalog);
    const catalog = {
      generatedAgainst: "2026.08.11-e8db854",
      rawModelIds: ["model-low", "model-high"],
      rawModelSelections: {
        "model-low": { model: "model", options: { effort: "low" } },
        "model-high": { model: "model", options: { effort: "high" } },
      },
      models: [
        {
          value: "model",
          label: "Model",
          default: true,
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
          ],
        },
      ],
    } as const;

    assert.throws(() =>
      decodeCatalog({
        ...catalog,
        models: [
          { ...catalog.models[0], options: [...catalog.models[0].options, ...catalog.models[0].options] },
          catalog.models[0],
        ],
      }),
    );
    assert.throws(() => decodeCatalog({ ...catalog, models: [{ ...catalog.models[0], default: false }] }));
    assert.throws(() =>
      decodeCatalog({
        ...catalog,
        rawModelSelections: {
          ...catalog.rawModelSelections,
          "model-low": { model: "model", options: { effort: "bogus", ghost: true } },
        },
      }),
    );
    assert.throws(() =>
      decodeCatalog({
        ...catalog,
        rawModelSelections: {
          ...catalog.rawModelSelections,
          "model-high": { model: "model", options: { effort: "low" } },
        },
      }),
    );
  });
});
