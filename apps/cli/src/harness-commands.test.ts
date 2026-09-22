import {
  defaultControlStore,
  HarnessItem,
  HarnessName,
  HarnessOverview,
  HarnessState,
} from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { formatHarnesses, formatOfflineHarnesses } from "./harness-commands";

const harness = Schema.decodeSync(HarnessName);
const item = (name: string, enabled: boolean) =>
  HarnessItem.make({
    harness: harness(name),
    enabled,
    version: null,
    state: HarnessState.cases.Ready.make({}),
    catalog: { models: [], policyProfiles: [], provenance: { source: "managed" } },
  });

describe("Harness commands", () => {
  it("preserves Harness registry order", () => {
    const overview = HarnessOverview.make({
      harnesses: [item("codex", true), item("cursor", false)],
      checkedAtMillis: 0,
    });

    assert.strictEqual(formatHarnesses(overview), "codex\tenabled\tReady\ncursor\tdisabled\tReady");
  });

  it("labels daemon-only readiness when the daemon is offline", () => {
    const controlStore = {
      ...defaultControlStore,
      harnessSettings: [{ harness: harness("cursor"), enabled: false }],
    };

    assert.strictEqual(
      formatOfflineHarnesses(controlStore),
      "readiness\tneeds a daemon\nunlisted Harnesses\tenabled\ncursor\tdisabled\tneeds a daemon",
    );
  });
});
