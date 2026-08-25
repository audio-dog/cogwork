import { type AgUiEvent, ClassifiedItem, DaemonEvent, RunSummary } from "@cogwork/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  ingestDaemonEvent,
  initialActivitySession,
  resetActivityFolds,
  unprocessedDaemonEvents,
} from "./activity-session";
import { previewMap } from "./run-activity";

const decodeEvent = Schema.decodeUnknownSync(DaemonEvent);
const decodeRun = Schema.decodeSync(RunSummary);
const decodeItem = Schema.decodeSync(ClassifiedItem);
const event = (value: Record<string, unknown>) => decodeEvent({ emittedAtMillis: 0, ...value });

const run = (over: Partial<Parameters<typeof decodeRun>[0]> = {}) =>
  decodeRun({
    id: "run-1",
    workspace: "acme",
    workItem: "42",
    stage: "implement",
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
      stage: "implement",
      seq: 0,
      atMillis: 0,
      correlation: { threadId: null, messageId: null, toolCallId: agui.toolCallId ?? null },
      event: agui,
    },
  });

describe("activity session", () => {
  it("rebuilds folds from a reconnect seed while keeping each log event once", () => {
    const seed = event({
      _tag: "ItemChanged",
      workspace: "acme",
      item: decodeItem({ _tag: "Eligible", id: "old", title: "Old", stage: "implement" }),
    });
    const live = event({ _tag: "RunChanged", run: run() });
    const replacement = event({
      _tag: "ItemChanged",
      workspace: "acme",
      item: decodeItem({ _tag: "Eligible", id: "new", title: "New", stage: "implement" }),
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
