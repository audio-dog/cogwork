import { assert, describe, it } from "@effect/vitest";
import {
  admissibleSettingScope,
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
