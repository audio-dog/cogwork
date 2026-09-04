import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { HarnessName } from "./base-schemas";
import { HarnessEnablement, HarnessItem, harnessEnabled } from "./harness";

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
    const item = Schema.decodeSync(HarnessItem)({
      harness: "codex",
      version: null,
      state: { _tag: "Ready" },
      models: [],
    });

    assert.isTrue(item.enabled);
  });
});
