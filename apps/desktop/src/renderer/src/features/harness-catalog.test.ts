import { defaultControlStore, HarnessEnablement, HarnessName } from "@cogwork/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { harnessIsDisabled, selectableHarnessCatalogs, unavailableHarnessLabel } from "./harness-catalog";

const harness = Schema.decodeSync(HarnessName);

describe("selectableHarnessCatalogs", () => {
  it("omits disabled Harnesses from new choices", () => {
    const catalogs = selectableHarnessCatalogs({
      ...defaultControlStore,
      harnessSettings: [HarnessEnablement.make({ harness: harness("cursor"), enabled: false })],
    });

    expect(catalogs.map((catalog) => catalog.harness)).toEqual(["codex", "provider"]);
  });

  it("identifies a disabled Harness without a static catalog", () => {
    const disabled = harness("claude");

    expect(
      harnessIsDisabled(
        {
          ...defaultControlStore,
          harnessSettings: [HarnessEnablement.make({ harness: disabled, enabled: false })],
        },
        disabled,
      ),
    ).toBe(true);
  });

  it("distinguishes an enabled non-catalog Harness when no choice remains", () => {
    expect(unavailableHarnessLabel("claude", false)).toBe("claude · no longer offered");
    expect(unavailableHarnessLabel("claude", true)).toBe("claude · disabled");
  });
});
