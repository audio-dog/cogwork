import { assert, describe, it } from "@effect/vitest";
import { claimLabel, defaultRoleLabels, hasClaimLabel, roleLabelsFor, rolesFrom } from "./markers";

describe("linear markers", () => {
  it("defaults role labels to the state: convention", () => {
    assert.deepStrictEqual(roleLabelsFor(), defaultRoleLabels);
    assert.strictEqual(
      roleLabelsFor({ "ready-for-agent": "custom:ready" })["ready-for-agent"],
      "custom:ready",
    );
  });

  it("maps labels through config and treats Canceled as wontfix", () => {
    const roles = rolesFrom(
      ["state:ready-for-agent", "bug"],
      { name: "Canceled", type: "canceled" },
      defaultRoleLabels,
    );
    assert.deepStrictEqual(roles, ["ready-for-agent", "wontfix"]);
    const renamed = rolesFrom(
      ["state:ready-for-agent"],
      { name: "Won't do", type: "canceled" },
      defaultRoleLabels,
    );
    assert.deepStrictEqual(renamed, ["ready-for-agent", "wontfix"]);
  });

  it("detects the claim label", () => {
    assert.isTrue(hasClaimLabel(["bug", claimLabel]));
    assert.isFalse(hasClaimLabel(["bug"]));
  });
});
