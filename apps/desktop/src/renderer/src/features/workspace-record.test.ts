import {
  applyDaemonEvent,
  DaemonEvent,
  initialBoard,
  type WorkspaceId,
  WorkspaceState,
} from "@cogwork/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  draftAfterSubmission,
  emptyDraft,
  seededDraft,
  workspaceLabelById,
  workspaceRecordDraftError,
  workspaceRecordWritable,
  workspaceUpdateFromDraft,
} from "./workspace-record";

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
        record: {
          name: displayName ?? name,
          checkoutPath: "/tmp/checkout",
          issueTracker: { type: "github" },
          linearHistory: false,
        },
        contributions: [],
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

describe("workspace record draft", () => {
  it("does not expose retired actor selectors", () => {
    expect(emptyDraft).not.toHaveProperty("trackerActorLogin");
    expect(emptyDraft).not.toHaveProperty("trackerActorUserId");
    expect(emptyDraft).not.toHaveProperty("sourceControlActorLogin");
  });

  it("round-trips every editable registration field", () => {
    const state = Schema.decodeSync(WorkspaceState)({
      _tag: "Registered",
      name: "01a05d92-f135-7e4a-b80b-40484b5d9775",
      displayName: "cogwork",
      checkoutPath: "/repos/cogwork",
      issueTracker: "linear",
      record: {
        name: "cogwork",
        checkoutPath: "/repos/cogwork",
        issueTracker: {
          type: "linear",
          connectionId: "linear/acme",
          teams: ["ENG"],
          organization: "acme",
        },
        sourceControl: {
          type: "github",
          connectionId: "github/acme",
          botAllowlist: ["dependabot"],
        },
        linearHistory: true,
        worktrees: {
          root: "/worktrees",
          linkPaths: ["config/a,b.json"],
          setup: ["pnpm install --filter=a,b"],
        },
        concurrency: 3,
        mcpSkills: [],
      },
      contributions: [],
    });

    const draft = seededDraft(state);
    const update = workspaceUpdateFromDraft(draft);
    if (!WorkspaceState.guards.Registered(state)) return expect.fail("expected record");
    const { checkoutPath: _checkoutPath, ...expected } = state.record;

    expect(update).toEqual(expected);
  });

  it("keeps failed workspace records read-only while preserving their checkout path", () => {
    const state = Schema.decodeSync(WorkspaceState)({
      _tag: "Failed",
      name: "01a05d92-f135-7e4a-b80b-40484b5d9775",
      displayName: "cogwork",
      source: "/repos/cogwork",
      message: "Workspace input failed",
    });

    expect(seededDraft(state).checkoutPath).toBe("/repos/cogwork");
    expect(workspaceRecordWritable(state)).toBe(false);
  });

  it("rejects an invalid priority field ID instead of clearing it", () => {
    expect(
      workspaceUpdateFromDraft({
        ...emptyDraft,
        displayName: "cogwork",
        issueTrackerConnectionId: "github/acme",
        priorityFieldId: "not-a-field-id",
      }),
    ).toBeNull();
  });

  it("treats blank MCP skills as an empty list", () => {
    expect(
      workspaceUpdateFromDraft({
        ...emptyDraft,
        displayName: "cogwork",
        issueTrackerConnectionId: "github/acme",
        mcpSkills: "",
      })?.mcpSkills,
    ).toEqual([]);
  });

  it("rejects unbound Connections before save", () => {
    expect(workspaceUpdateFromDraft({ ...emptyDraft, displayName: "cogwork" })).toBeNull();
    expect(
      workspaceUpdateFromDraft({
        ...emptyDraft,
        displayName: "cogwork",
        issueTrackerConnectionId: "github/acme",
        sourceControlType: "github",
      }),
    ).toBeNull();
  });

  it("names the missing Connection that prevents save", () => {
    expect(workspaceRecordDraftError(emptyDraft)).toBe("Choose an issue tracker Connection.");
    expect(
      workspaceRecordDraftError({
        ...emptyDraft,
        issueTrackerConnectionId: "github/acme",
        sourceControlType: "github",
      }),
    ).toBe("Choose a source control Connection.");
    expect(
      workspaceRecordDraftError({
        ...emptyDraft,
        issueTrackerConnectionId: "github/acme",
      }),
    ).toBe("Check the workspace fields. JSON and positive numbers must be valid.");
  });

  it("holds every normalized field after submission", () => {
    const draft = {
      ...emptyDraft,
      displayName: "  cogwork  ",
      issueTrackerConnectionId: "github/acme",
      teams: " ENG, APP ",
      assigneeAllowlist: ["taylorfsteele", "cogwork-bot"],
      priorityFieldId: " 12 ",
      worktreeRoot: " /worktrees ",
      worktreeLinkPaths: " package.json \n config.json ",
      worktreeReapAfterMillis: " 60000 ",
      concurrency: " 3 ",
    };
    const update = workspaceUpdateFromDraft(draft);

    expect(update).not.toBeNull();
    expect(draftAfterSubmission(draft, "/repos/cogwork", update)).toMatchObject({
      displayName: "cogwork",
      checkoutPath: "/repos/cogwork",
      teams: "ENG, APP",
      assigneeAllowlist: ["taylorfsteele", "cogwork-bot"],
      priorityFieldId: "12",
      worktreeRoot: "/worktrees",
      worktreeLinkPaths: "package.json\nconfig.json",
      worktreeReapAfterMillis: "60000",
      concurrency: "3",
    });
  });
});
