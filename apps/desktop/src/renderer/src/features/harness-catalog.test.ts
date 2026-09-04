import { defaultControlStore, HarnessEnablement, HarnessName } from "@cogwork/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { selectableHarnessCatalogs } from "./harness-catalog";

const harness = Schema.decodeSync(HarnessName);

describe("selectableHarnessCatalogs", () => {
  it("omits disabled Harnesses from new choices", () => {
    const catalogs = selectableHarnessCatalogs({
      ...defaultControlStore,
      harnessSettings: [HarnessEnablement.make({ harness: harness("cursor"), enabled: false })],
    });

    expect(catalogs.map((catalog) => catalog.harness)).toEqual(["codex", "provider"]);
  });
});
