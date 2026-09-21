import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  admissibleSettingScope,
  applyOperationSettingBatch,
  ContributionSettingUpdate,
  defaultContributionEnabled,
  OperationSettingBatch,
  type OperationSettingLevel,
  OperationSettingUpdate,
  resolveContributionEnabled,
  resolveContributionUnion,
  resolveOperationSetting,
  type SettingsProfileScope,
  settingResolutionCases,
  settingScopeDirection,
} from "./settings";

describe("shared setting resolution cases", () => {
  for (const testCase of settingResolutionCases) {
    it(testCase.name, () => {
      if (testCase._tag === "Direction") {
        assert.deepStrictEqual(settingScopeDirection, testCase.expected);
        return;
      }
      if (testCase._tag === "Admissible") {
        assert.strictEqual(
          admissibleSettingScope(testCase.family, testCase.setting, testCase.scope),
          testCase.expected,
        );
        return;
      }

      if (testCase._tag === "ContributionDefault") {
        assert.strictEqual(defaultContributionEnabled(testCase.authority), testCase.expected);
        return;
      }

      if (testCase._tag === "ContributionEnabled") {
        assert.deepStrictEqual(resolveContributionEnabled(testCase.rows), testCase.expected);
        return;
      }

      if (testCase._tag === "ContributionUnion") {
        assert.deepStrictEqual(resolveContributionUnion(testCase.rows), testCase.expected);
        return;
      }

      assert.deepStrictEqual(
        resolveOperationSetting(testCase.rows, testCase.setting, testCase.context),
        testCase.expected,
      );
    });
  }
});

describe("ContributionSettingUpdate", () => {
  const contribution = { id: "local:repo/mcp/tools", kind: "mcp-server" };

  it("accepts an MCP server row at a Private workspace overlay", () => {
    assert.isTrue(
      Schema.is(ContributionSettingUpdate)({
        _tag: "Set",
        row: {
          contribution,
          scope: { _tag: "PrivateWorkspaceOverlay", workspace: "workspace" },
          enabled: true,
        },
      }),
    );
  });

  it("makes a Workspace input row unrepresentable", () => {
    assert.isFalse(
      Schema.is(ContributionSettingUpdate)({
        _tag: "Set",
        row: {
          contribution,
          scope: { _tag: "WorkspaceInput", workspace: "workspace" },
          enabled: true,
        },
      }),
    );
  });
});

describe("OperationSettingUpdate", () => {
  it("accepts model option selections and rejects the retired effort setting", () => {
    assert.isTrue(
      Schema.is(OperationSettingUpdate)({
        _tag: "Set",
        row: {
          level: { _tag: "Operation", workflow: "coding", operation: "implement" },
          scope: { _tag: "SettingsProfile" },
          setting: "model-options",
          value: { effort: "high", speed: true },
        },
      }),
    );
    assert.isFalse(
      Schema.is(OperationSettingUpdate)({
        _tag: "Set",
        row: {
          level: { _tag: "Operation", workflow: "coding", operation: "implement" },
          scope: { _tag: "SettingsProfile" },
          setting: "effort",
          value: "high",
        },
      }),
    );
  });

  it("rejects an Operation level for an operation the build does not have", () => {
    assert.isFalse(
      Schema.is(OperationSettingUpdate)({
        _tag: "Set",
        row: {
          setting: "model",
          level: { _tag: "Operation", workflow: "coding", operation: "verify" },
          scope: { _tag: "SettingsProfile" },
          value: "openai/gpt-5",
        },
      }),
    );
  });

  it("requires a non-empty batch", () => {
    assert.isFalse(Schema.is(OperationSettingBatch)([]));
    assert.isTrue(
      Schema.is(OperationSettingBatch)([
        {
          _tag: "Clear",
          cell: {
            setting: "model-options",
            level: { _tag: "Operation", workflow: "coding", operation: "implement" },
            scope: { _tag: "SettingsProfile" },
          },
        },
      ]),
    );
    assert.isFalse(
      Schema.is(OperationSettingBatch)(
        Array.from({ length: 5 }, () => ({
          _tag: "Clear",
          cell: {
            setting: "model-options",
            level: { _tag: "Operation", workflow: "coding", operation: "implement" },
            scope: { _tag: "SettingsProfile" },
          },
        })),
      ),
    );
  });

  it("applies every update in order", () => {
    const level = {
      _tag: "Operation",
      workflow: "coding",
      operation: "implement",
    } satisfies OperationSettingLevel;
    const scope = { _tag: "SettingsProfile" } satisfies SettingsProfileScope;
    const rows = applyOperationSettingBatch(
      [{ setting: "model", level, scope, value: "old" }],
      [
        { _tag: "Set", row: { setting: "model", level, scope, value: "new" } },
        {
          _tag: "Set",
          row: { setting: "model-options", level, scope, value: { effort: "high" } },
        },
        { _tag: "Clear", cell: { setting: "model-options", level, scope } },
      ],
    );

    assert.deepStrictEqual(rows, [{ setting: "model", level, scope, value: "new" }]);
  });
});
