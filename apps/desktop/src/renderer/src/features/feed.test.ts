import { applyDaemonEvent, DaemonEvent, initialBoard } from "@cogwork/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { queuedItems } from "./feed";

const decodeDaemonEvent = Schema.decodeUnknownSync(DaemonEvent);

describe("queuedItems", () => {
  it("excludes ready-to-merge items", () => {
    const event = decodeDaemonEvent({
      _tag: "ItemChanged",
      emittedAtMillis: 0,
      workspace: "acme",
      item: {
        _tag: "ReadyToMerge",
        id: "1",
        title: "Approved",
        pr: {
          number: 1,
          url: "https://example.test/pull/1",
          checks: "passing",
          review: "ready",
          baseDivergence: "none",
          waitingSinceMillis: 0,
        },
      },
    });
    const board = applyDaemonEvent(initialBoard, event);

    expect(queuedItems(board, null)).toEqual([]);
  });
});
