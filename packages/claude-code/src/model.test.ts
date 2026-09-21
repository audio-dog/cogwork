import { HarnessManagedCatalog, HarnessModelOptionDescriptor } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { ClaudeNativeSelectionResult, claudeNativeSelection } from "./model";
import { claudeModelCatalog } from "./models.generated";

describe("Claude model catalog", () => {
  it("ships the generated Claude models, aliases, and one default", () => {
    assert.match(claudeModelCatalog.generatedAgainst, /^\d+\.\d+\.\d+ \(Claude Code\)$/);
    assert.deepStrictEqual(
      claudeModelCatalog.models.map(({ value }) => value),
      [
        "sonnet",
        "opus",
        "haiku",
        "fable",
        "best",
        "claude-fable-5-1",
        "claude-fable-5",
        "claude-opus-5",
        "claude-opus-4-8",
        "claude-opus-4-7",
        "claude-opus-4-6",
        "claude-sonnet-5",
        "claude-sonnet-4-6",
        "claude-haiku-4-5",
      ],
    );
    assert.deepStrictEqual(
      claudeModelCatalog.models.filter(({ default: isDefault }) => isDefault).map(({ value }) => value),
      ["sonnet"],
    );
  });

  it("declares only the effort and context axes each model supports", () => {
    const opus47 = claudeModelCatalog.models.find(({ value }) => value === "claude-opus-4-7");
    const opus46 = claudeModelCatalog.models.find(({ value }) => value === "claude-opus-4-6");
    const haiku = claudeModelCatalog.models.find(({ value }) => value === "haiku");
    const opus47Effort = opus47?.options?.find(({ id }) => id === "effort");
    const opus46Effort = opus46?.options?.find(({ id }) => id === "effort");

    assert.deepStrictEqual(opus47Effort, {
      type: "select",
      id: "effort",
      label: "Effort",
      values: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
        { value: "xhigh", label: "Extra High" },
        { value: "max", label: "Max" },
      ],
      defaultValue: "xhigh",
    });
    const opus46EffortValues = opus46Effort
      ? HarnessModelOptionDescriptor.match(opus46Effort, {
          boolean: () => [],
          select: ({ values }) => values.map(({ value }) => value),
        })
      : [];
    assert.deepStrictEqual(opus46EffortValues, ["low", "medium", "high", "max"]);
    assert.deepStrictEqual(
      opus47?.options?.find(({ id }) => id === "context"),
      {
        type: "boolean",
        id: "context",
        label: "1M Context",
        defaultValue: false,
      },
    );
    assert.isUndefined(haiku?.options);
    assert.doesNotThrow(() => Schema.decodeSync(HarnessManagedCatalog)(claudeModelCatalog));
  });

  it("translates catalog defaults and selected options to Claude native values", () => {
    assert.deepStrictEqual(
      claudeNativeSelection(claudeModelCatalog, null, {}),
      ClaudeNativeSelectionResult.Success({ model: "sonnet", effort: "high" }),
    );
    assert.deepStrictEqual(
      claudeNativeSelection(claudeModelCatalog, "sonnet", { effort: "low", context: true }),
      ClaudeNativeSelectionResult.Success({ model: "sonnet[1m]", effort: "low" }),
    );
    assert.deepStrictEqual(
      claudeNativeSelection(claudeModelCatalog, "haiku", {}),
      ClaudeNativeSelectionResult.Success({ model: "haiku" }),
    );
  });

  it("rejects selections absent from a model descriptor", () => {
    assert.deepStrictEqual(
      claudeNativeSelection(claudeModelCatalog, "haiku", { effort: "high" }),
      ClaudeNativeSelectionResult.Failure({ error: "Claude model haiku does not declare option effort" }),
    );
    assert.deepStrictEqual(
      claudeNativeSelection(claudeModelCatalog, "claude-opus-4-6", { effort: "xhigh" }),
      ClaudeNativeSelectionResult.Failure({
        error: 'Claude model claude-opus-4-6 option effort does not allow "xhigh"',
      }),
    );
  });
});
