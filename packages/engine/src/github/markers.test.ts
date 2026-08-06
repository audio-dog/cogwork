import { assert, describe, it } from "@effect/vitest";
import { claimLabel, hasClaimLabel, rolesFromLabels } from "./markers";

describe("github markers", () => {
  it("maps only recognized tracker labels to canonical roles", () => {
    const roles = rolesFromLabels(["ready-for-agent", "needs-info", "priority-high", "wontfix"]);
    assert.deepStrictEqual([...roles].sort(), ["needs-info", "ready-for-agent", "wontfix"]);
  });

  it("detects the claim label", () => {
    assert.isTrue(hasClaimLabel(["bug", claimLabel]));
    assert.isFalse(hasClaimLabel(["bug"]));
  });
});
