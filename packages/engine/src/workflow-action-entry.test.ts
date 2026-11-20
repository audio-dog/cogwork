import { assert, describe, it } from "@effect/vitest";

import { actionEntryFor, compareActionPhase, registeredActionRows } from "./workflow-action-registry";

describe("Action entry registry", () => {
  it("resolves an entry by its full catalog key only", () => {
    assert.isNotEmpty(registeredActionRows);
    assert.isTrue(registeredActionRows.every((row) => actionEntryFor(row.key)?.row === row));
    assert.isUndefined(actionEntryFor("notify"));
    assert.isUndefined(actionEntryFor("slack.notify"));
  });

  it("orders actions by phase, then document position", () => {
    const documentOrder = [
      "cogwork.stop",
      "cogwork.notify",
      "github.add-label",
      "cogwork.hand-to-me",
      "cogwork.withdraw-pending-approval",
      "cogwork.wait-for-approval",
      "github.comment-this-item",
    ];

    assert.deepStrictEqual(documentOrder.toSorted(compareActionPhase), [
      "cogwork.wait-for-approval",
      "github.add-label",
      "cogwork.withdraw-pending-approval",
      "github.comment-this-item",
      "cogwork.notify",
      "cogwork.stop",
      "cogwork.hand-to-me",
    ]);
  });
});
