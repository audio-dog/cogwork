import {
  type AgUiEvent,
  DaemonEvent,
  initialBoard,
  ReadModelItem,
  RunSummary,
  WorkflowRecord,
} from "@cogwork/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import {
  BoardResult,
  ingestDaemonEvent,
  initialActivitySession,
  resetActivityFolds,
  unprocessedDaemonEvents,
} from "./activity-session";
import { previewMap } from "./run-activity";

const decodeEvent = Schema.decodeUnknownSync(DaemonEvent);
const decodeRun = Schema.decodeSync(RunSummary);
const decodeItem = Schema.decodeSync(ReadModelItem);
const decodeWorkflow = Schema.decodeUnknownSync(WorkflowRecord);
const event = (value: Record<string, unknown>) => decodeEvent({ emittedAtMillis: 0, ...value });
const readyToMerge = (id: string, title: string) =>
  decodeItem({
    _tag: "ReadyToMerge",
    id,
    title,
    pr: {
      number: 1,
      url: "https://example.test/pull/1",
      checks: "passing",
      review: "ready",
      baseDivergence: "clean",
      waitingSinceMillis: 0,
    },
  });

const run = (over: Partial<Parameters<typeof decodeRun>[0]> = {}) =>
  decodeRun({
    id: "run-1",
    workspace: "acme",
    workItem: "42",
    operation: "implement",
    harness: "cursor",
    branch: null,
    session: null,
    usage: null,
    status: "running",
    startedAtMillis: 100,
    endedAtMillis: null,
    eventCount: 0,
    ...over,
  });

const activity = (runId: string, agui: AgUiEvent & { type: string }) =>
  event({
    _tag: "RunActivity",
    activity: {
      runId,
      workspace: "acme",
      workItem: "42",
      operation: "implement",
      seq: 0,
      atMillis: 0,
      correlation: { threadId: null, messageId: null, toolCallId: agui.toolCallId ?? null },
      event: agui,
    },
  });

describe("activity session", () => {
  it("keeps the Workflow view current through change and delete events", () => {
    const workflow = decodeWorkflow({
      id: "workflow-1",
      principal: "person",
      workingCopy: {
        name: "Shared Workflow",
        workspaces: { _tag: "Every" },
        triggers: [],
        operations: [],
      },
      workingRevision: 1,
      publishedCopy: null,
      publishedRevision: null,
      enabled: false,
      diagnostics: [],
      readiness: [],
    });
    const changed = ingestDaemonEvent(
      initialActivitySession,
      event({ _tag: "WorkflowChanged", workflow }),
      1,
    );
    const removed = ingestDaemonEvent(changed, event({ _tag: "WorkflowDeleted", id: workflow.id }), 2);

    expect(changed.workflows.get(workflow.id)).toEqual(workflow);
    expect(removed.workflows.has(workflow.id)).toBe(false);
  });

  it("constructs and folds every board result", () => {
    const initial = BoardResult.Initial();
    const failure = BoardResult.Failure();
    const success = BoardResult.Success({ board: initialBoard, previews: new Map() });
    const label = BoardResult.$match({
      Initial: () => "initial",
      Failure: () => "failure",
      Success: ({ board }) => (board === initialBoard ? "success" : "wrong board"),
    });

    expect([label(initial), label(failure), label(success)]).toEqual(["initial", "failure", "success"]);
  });

  it("rebuilds folds from a reconnect seed while keeping each log event once", () => {
    const seed = event({
      _tag: "ItemChanged",
      workspace: "acme",
      item: readyToMerge("old", "Old"),
    });
    const live = event({ _tag: "RunChanged", run: run() });
    const replacement = event({
      _tag: "ItemChanged",
      workspace: "acme",
      item: readyToMerge("new", "New"),
    });
    const first = [seed, event({ _tag: "SeedEnd" }), live].reduce(
      (session, next) => ingestDaemonEvent(session, next, 1),
      initialActivitySession,
    );
    const reconnected = [seed, replacement, event({ _tag: "SeedEnd" })].reduce(
      (session, next) => ingestDaemonEvent(session, next, 2),
      resetActivityFolds(first),
    );

    expect(reconnected.board.items.has("acme::old")).toBe(true);
    expect(reconnected.board.items.has("acme::new")).toBe(true);
    expect(reconnected.board.runs.size).toBe(0);
    expect(reconnected.log.map((row) => row.summary)).toEqual(["42 · run running"]);
  });

  it("names a registered and a deregistered workspace by display name", () => {
    const id = "01a1a28e-b763-7ccb-9208-2b284d962dae";
    const session = [
      event({ _tag: "SeedEnd" }),
      event({
        _tag: "WorkspaceChanged",
        workspace: {
          _tag: "Registered",
          id,
          displayName: "cogwork",
          checkoutPath: "/repos/cogwork",
          issueTracker: "github",
          record: {
            displayName: "cogwork",
            checkoutPath: "/repos/cogwork",
            issueTracker: { type: "github" },
            linearHistory: false,
          },
          contributions: [],
        },
      }),
      event({ _tag: "WorkspaceRemoved", workspace: id, displayName: "cogwork" }),
    ].reduce((current, next, arrival) => ingestDaemonEvent(current, next, arrival), initialActivitySession);

    expect(session.log.map((row) => row.summary).toSorted()).toEqual([
      "cogwork deregistered",
      "cogwork registered · github",
    ]);
  });

  it("refreshes Workflow inputs for live changes, not seed events", () => {
    const changed = event({ _tag: "WorkspaceRemoved", workspace: "acme" });
    const seeded = ingestDaemonEvent(initialActivitySession, changed, 1);
    const live = ingestDaemonEvent(ingestDaemonEvent(seeded, event({ _tag: "SeedEnd" }), 2), changed, 3);

    expect(seeded.workflowInputsRevision).toBe(0);
    expect(live.workflowInputsRevision).toBe(1);
  });

  it("releases a terminal run's preview scratch state", () => {
    const withPreview = ingestDaemonEvent(
      initialActivitySession,
      activity("run-1", { type: "TEXT_MESSAGE_CONTENT", delta: "hello" }),
      1,
    );
    const settled = ingestDaemonEvent(
      withPreview,
      event({ _tag: "RunChanged", run: run({ status: "succeeded" }) }),
      2,
    );

    expect(previewMap(withPreview.previews).get("run-1")).toEqual({ label: "responding", text: "hello" });
    expect(settled.previews.has("run-1")).toBe(false);
  });

  it("does not recreate a terminal run's preview scratch state", () => {
    const settled = ingestDaemonEvent(
      initialActivitySession,
      event({ _tag: "RunChanged", run: run({ status: "succeeded" }) }),
      1,
    );
    const withLateActivity = ingestDaemonEvent(
      settled,
      activity("run-1", { type: "TEXT_MESSAGE_CONTENT", delta: "late" }),
      2,
    );

    expect(withLateActivity.previews.has("run-1")).toBe(false);
  });

  it("does not re-fold an already processed daemon-event batch", () => {
    const items = [event({ _tag: "RunChanged", run: run() })];

    expect(unprocessedDaemonEvents(null, items)).toBe(items);
    expect(unprocessedDaemonEvents(items, items)).toBeNull();
  });

  it("mints a distinct row identity for identical arrivals", () => {
    const duplicate = event({ _tag: "ItemRemoved", workspace: "acme", id: "42" });
    const session = [event({ _tag: "SeedEnd" }), duplicate, duplicate].reduce(
      (current, next) => ingestDaemonEvent(current, next, 1),
      initialActivitySession,
    );

    expect(new Set(session.log.map((row) => row.id)).size).toBe(2);
  });
});
