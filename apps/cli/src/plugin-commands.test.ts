import { assert, describe, it } from "@effect/vitest";

import { formatPluginMutation } from "./plugin-commands";

describe("formatPluginMutation", () => {
  it("includes retained Connection notices", () => {
    assert.strictEqual(
      formatPluginMutation("Uninstalled", {
        overview: { plugins: [] },
        notices: ["The Linear Connection remains established."],
      }),
      "Uninstalled Plugin.\nNotice: The Linear Connection remains established.",
    );
  });
});
