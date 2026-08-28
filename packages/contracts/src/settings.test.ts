import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  admissibleSettingScope,
  ContributionSettingUpdate,
  defaultContributionEnabled,
  resolveContributionEnabled,
  resolveContributionUnion,
  resolveOperationSetting,
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
