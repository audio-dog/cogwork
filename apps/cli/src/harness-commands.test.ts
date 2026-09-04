import { HarnessItem, HarnessName, HarnessOverview, HarnessState } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { formatHarnesses } from "./harness-commands";

const harness = Schema.decodeSync(HarnessName);
const item = (name: string, enabled: boolean) =>
  HarnessItem.make({
    harness: harness(name),
    enabled,
    version: null,
    state: HarnessState.cases.Ready.make({}),
    models: [],
  });

describe("Harness commands", () => {
  it("lists disabled Harnesses first", () => {
    const overview = HarnessOverview.make({
      harnesses: [item("codex", true), item("cursor", false)],
      checkedAtMillis: 0,
    });

    assert.strictEqual(formatHarnesses(overview), "cursor\tdisabled\tReady\ncodex\tenabled\tReady");
  });
});
