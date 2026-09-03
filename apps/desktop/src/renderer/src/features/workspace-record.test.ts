import { applyDaemonEvent, DaemonEvent, initialBoard, type WorkspaceId } from "@cogwork/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { workspaceLabelById } from "./workspace-record";

const decodeDaemonEvent = Schema.decodeUnknownSync(DaemonEvent);

const registered = (name: string, displayName?: string) =>
  applyDaemonEvent(
    initialBoard,
    decodeDaemonEvent({
      _tag: "WorkspaceChanged",
      emittedAtMillis: 0,
      workspace: {
        _tag: "Registered",
        name,
        ...(displayName ? { displayName } : {}),
        checkoutPath: "/tmp/checkout",
        issueTracker: "github",
        poll: { status: "ok" },
        contributions: [],
        availability: [],
      },
    }),
  );

const id = (value: string) => value as WorkspaceId;

describe("workspaceLabelById", () => {
  it("reads the name a person gave the workspace", () => {
    const board = registered("01a05d92-f135-7e4a-b80b-40484b5d9775", "cogwork");

    expect(workspaceLabelById(board, id("01a05d92-f135-7e4a-b80b-40484b5d9775"))).toBe("cogwork");
  });

  it("falls back to the id when the workspace named itself nothing", () => {
    const board = registered("01a05d92-f135-7e4a-b80b-40484b5d9775");

    expect(workspaceLabelById(board, id("01a05d92-f135-7e4a-b80b-40484b5d9775"))).toBe(
      "01a05d92-f135-7e4a-b80b-40484b5d9775",
    );
  });

  it("falls back to the id for a workspace the board has never seen", () => {
    expect(workspaceLabelById(initialBoard, id("01a05d92-f5a6-769c-99d7-b8f5332baa72"))).toBe(
      "01a05d92-f5a6-769c-99d7-b8f5332baa72",
    );
  });
});
