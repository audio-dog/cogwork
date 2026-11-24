import {
  HarnessName,
  HarnessOptionCatalog,
  HarnessReadiness,
  HarnessReadinessItem,
  HarnessState,
} from "@cogwork/contracts";
import * as Schema from "effect/Schema";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  type AvailableHarnessCatalog,
  type ModelOptionState,
  providerPickerCatalogs,
} from "../features/operation-settings";
import { ProviderPicker } from "./provider-picker";

const harness = Schema.decodeSync(HarnessName)("codex");
const model = {
  value: "model-a",
  label: "Model A",
  options: [
    {
      type: "select" as const,
      id: "effort",
      label: "Effort",
      values: [
        { value: "low", label: "Low" },
        { value: "high", label: "High" },
      ],
      defaultValue: "high",
    },
    { type: "boolean" as const, id: "speed", label: "Speed", defaultValue: false },
  ],
};
const catalog = {
  ...HarnessOptionCatalog.make({
    models: [model],
    policyProfiles: ["full"],
    provenance: { source: "managed" },
  }),
  harness,
} satisfies AvailableHarnessCatalog;
const readiness = HarnessReadiness.make({
  checkedAtMillis: 1,
  harnesses: [
    HarnessReadinessItem.make({
      harness,
      version: null,
      state: HarnessState.cases.Unavailable.make({ diagnostic: "Probe failed" }),
    }),
  ],
});
const options = [
  { descriptor: model.options[0], value: "high", source: "inherited" },
  { descriptor: model.options[1], value: false, source: "default" },
] satisfies ReadonlyArray<ModelOptionState>;

describe("ProviderPicker", () => {
  it("keeps a saved unavailable selection visible with its model and option summary", () => {
    const providers = providerPickerCatalogs([catalog], readiness);
    const markup = renderToStaticMarkup(
      <ProviderPicker.Provider
        value={{
          state: {
            allProviders: providers,
            selectableProviders: providers,
            selectedHarness: harness,
            model: model.value,
            options,
            own: true,
            stale: false,
            disabledHarness: false,
          },
          actions: { pick: vi.fn<(harness: HarnessName, model: string) => void>() },
          meta: { disabled: false },
        }}
      >
        <ProviderPicker.Root>
          <ProviderPicker.Trigger />
        </ProviderPicker.Root>
      </ProviderPicker.Provider>,
    );

    expect(markup).toContain("Model A · High · Speed Off · Unavailable");
    expect(markup).toContain(
      'aria-label="Provider and model: Codex · Model A · High · Speed Off · Unavailable"',
    );
  });
});
