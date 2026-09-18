import { applyDaemonEvent, DaemonEvent, initialBoard } from "@cogwork/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { queuedItems, recentlyDone } from "./feed";

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

describe("recentlyDone", () => {
  it("includes a pull request creation decline", () => {
    const event = decodeDaemonEvent({
      _tag: "RunChanged",
      emittedAtMillis: 0,
      run: {
        id: "run-1",
        workspace: "acme",
        workItem: "1",
        stage: "implement",
        harness: "codex",
        branch: "1-fix",
        session: null,
        usage: null,
        status: "declined",
        startedAtMillis: 1,
        endedAtMillis: 2,
        eventCount: 0,
        eventsPrunedAtMillis: null,
      },
    });
    const board = applyDaemonEvent(initialBoard, event);

    expect(recentlyDone(board, null).map(({ run }) => run.status)).toEqual(["declined"]);
  });
});
