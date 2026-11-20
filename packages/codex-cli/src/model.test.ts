import { HarnessManagedCatalog } from "@cogwork/contracts";
import * as Schema from "effect/Schema";
import { assert, describe, it } from "vitest";

import { codexNativeEffort } from "./model";
import { codexCatalog, codexModels } from "./models.generated";

describe("codexCatalog", () => {
  it("ships the Codex models with native effort descriptors", () => {
    Schema.decodeSync(HarnessManagedCatalog)(codexCatalog);
    assert.strictEqual(codexCatalog.generatedAgainst, "0.154.0");
    assert.deepStrictEqual(codexCatalog.rawModelIds, codexModels);
    assert.strictEqual(codexCatalog.models.filter(({ default: isDefault }) => isDefault).length, 1);
    assert.strictEqual(codexCatalog.models.find(({ default: isDefault }) => isDefault)?.value, "gpt-5.6-sol");

    codexCatalog.models.forEach((model) => {
      assert.deepStrictEqual(model.options, [
        {
          type: "select",
          id: "effort",
          label: "Effort",
          values: [
            { value: "minimal", label: "Minimal" },
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
          ],
          defaultValue: "high",
        },
      ]);
    });
  });
});

describe("codexNativeEffort", () => {
  it("maps the selected canonical effort to Codex's native value", () => {
    assert.strictEqual(codexNativeEffort("gpt-5.6-sol", "minimal"), "minimal");
  });

  it("uses the model descriptor default when no effort is selected", () => {
    assert.strictEqual(codexNativeEffort("gpt-5.6-sol", null), "high");
  });
});
