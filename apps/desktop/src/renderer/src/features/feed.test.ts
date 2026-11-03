import { applyDaemonEvent, DaemonEvent, initialBoard } from "@cogwork/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { recentlyDone } from "./feed";

const decodeDaemonEvent = Schema.decodeUnknownSync(DaemonEvent);

describe("recentlyDone", () => {
  it("includes a pull request creation decline", () => {
    const event = decodeDaemonEvent({
      _tag: "RunChanged",
      emittedAtMillis: 0,
      run: {
        id: "run-1",
        workspace: "acme",
        workItem: "1",
        operation: "implement",
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
