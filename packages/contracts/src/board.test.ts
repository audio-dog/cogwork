import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { WorkspaceId } from "./base-schemas";
import { applyDaemonEvent, initialBoard } from "./board";
import { SchedulerStats } from "./daemon";
import { ClassifiedItem, DaemonEvent, WorkspaceState } from "./daemon-event";
import { RunSummary } from "./run";

const workspace = Schema.decodeSync(WorkspaceId);
const classifiedItem = Schema.decodeSync(ClassifiedItem);
const runSummary = Schema.decodeSync(RunSummary);
const schedulerStats = Schema.decodeSync(SchedulerStats);
const workspaceState = Schema.decodeSync(WorkspaceState);
const event = Schema.decodeSync(DaemonEvent);

const registered = (name: string) =>
  workspaceState({
    _tag: "Registered",
    name,
    checkoutPath: `/repos/${name}`,
    issueTracker: "github",
    harness: "cursor",
    poll: { status: "ok" },
  });

type Stage = "triage" | "implement" | "follow-up" | "verify";

const eligible = (id: string, stage: Stage) =>
  classifiedItem({ _tag: "Eligible", id, title: `Item ${id}`, stage });

const stageOf = (item: ClassifiedItem | undefined) => (item?._tag === "Eligible" ? item.stage : null);

const fold = (events: ReadonlyArray<DaemonEvent>) => events.reduce(applyDaemonEvent, initialBoard);

describe("applyDaemonEvent", () => {
  it("records the latest classified item per workspace and id", () => {
    const board = fold([
      event({ _tag: "ItemChanged", workspace: "acme", item: eligible("1", "triage") }),
      event({ _tag: "ItemChanged", workspace: "acme", item: eligible("1", "implement") }),
      event({ _tag: "ItemChanged", workspace: "acme", item: eligible("2", "triage") }),
    ]);

    assert.strictEqual(board.items.size, 2);
    const first = board.items.get("acme::1");
    assert.strictEqual(first?.item._tag, "Eligible");
    assert.strictEqual(stageOf(first?.item), "implement");
    assert.strictEqual(first?.workspace, workspace("acme"));
  });

  it("removes an item and leaves the rest of the board alone", () => {
    const board = fold([
      event({ _tag: "ItemChanged", workspace: "acme", item: eligible("1", "triage") }),
      event({ _tag: "ItemChanged", workspace: "acme", item: eligible("2", "triage") }),
      event({ _tag: "ItemRemoved", workspace: "acme", id: "1" }),
    ]);

    assert.strictEqual(board.items.size, 1);
    assert.isUndefined(board.items.get("acme::1"));
    assert.strictEqual(stageOf(board.items.get("acme::2")?.item), "triage");
  });

  it("removes an item only in its own workspace", () => {
    const board = fold([
      event({ _tag: "ItemChanged", workspace: "acme", item: eligible("1", "triage") }),
      event({ _tag: "ItemChanged", workspace: "beta", item: eligible("1", "verify") }),
      event({ _tag: "ItemRemoved", workspace: "acme", id: "1" }),
    ]);

    assert.strictEqual(board.items.size, 1);
    assert.isUndefined(board.items.get("acme::1"));
    assert.strictEqual(stageOf(board.items.get("beta::1")?.item), "verify");
  });

  it("tolerates removing an item the board never had", () => {
    const board = fold([event({ _tag: "ItemRemoved", workspace: "acme", id: "1" })]);
    assert.strictEqual(board.items.size, 0);
  });

  it("keeps items with the same id apart across workspaces", () => {
    const board = fold([
      event({ _tag: "ItemChanged", workspace: "acme", item: eligible("1", "triage") }),
      event({ _tag: "ItemChanged", workspace: "beta", item: eligible("1", "verify") }),
    ]);

    assert.strictEqual(board.items.size, 2);
    assert.strictEqual(stageOf(board.items.get("acme::1")?.item), "triage");
    assert.strictEqual(stageOf(board.items.get("beta::1")?.item), "verify");
  });

  it("is idempotent: applying the same event twice is harmless", () => {
    const changed = event({
      _tag: "ItemChanged",
      workspace: "acme",
      item: eligible("1", "implement"),
    });

    const once = applyDaemonEvent(initialBoard, changed);
    const twice = applyDaemonEvent(once, changed);

    assert.strictEqual(twice.items.size, 1);
    assert.strictEqual(stageOf(twice.items.get("acme::1")?.item), "implement");
  });

  it("tracks the latest run summary and scheduler stats", () => {
    const run = runSummary({
      id: "run-1",
      workspace: "acme",
      workItem: "1",
      stage: "implement",
      harness: "cursor",
      branch: null,
      session: null,
      usage: null,
      status: "running",
      startedAtMillis: 0,
      endedAtMillis: null,
      eventCount: 3,
    });
    const stats = schedulerStats({
      scheduling: "running",
      globalInFlight: 1,
      globalLimit: 4,
      dailyBudgetUsed: 2,
      dailyBudgetLimit: 10,
      perWorkspace: [{ name: "acme", inFlight: 1 }],
    });

    const board = fold([
      event({ _tag: "RunChanged", run }),
      event({ _tag: "SchedulerChanged", scheduler: stats }),
    ]);

    assert.strictEqual(board.runs.get("run-1")?.status, "running");
    assert.strictEqual(board.scheduler?.globalInFlight, 1);
  });

  it("records the latest workspace state per key, registered by name", () => {
    const board = fold([
      event({ _tag: "WorkspaceChanged", workspace: registered("acme") }),
      event({
        _tag: "WorkspaceChanged",
        workspace: workspaceState({
          _tag: "Registered",
          name: "acme",
          checkoutPath: "/repos/acme",
          issueTracker: "linear",
          harness: "cursor",
          poll: { status: "ok" },
        }),
      }),
    ]);

    assert.strictEqual(board.workspaces.size, 1);
    const acme = board.workspaces.get("acme");
    assert.strictEqual(acme?._tag, "Registered");
    assert.strictEqual(acme?._tag === "Registered" ? acme.issueTracker : null, "linear");
  });

  it("folds a failed workspace onto the board keyed by its source", () => {
    const board = fold([
      event({ _tag: "WorkspaceChanged", workspace: registered("acme") }),
      event({
        _tag: "WorkspaceChanged",
        workspace: workspaceState({ _tag: "Failed", source: "broken.workspace.ts", message: "boom" }),
      }),
    ]);

    assert.strictEqual(board.workspaces.size, 2);
    const failed = board.workspaces.get("broken.workspace.ts");
    assert.strictEqual(failed?._tag, "Failed");
    assert.strictEqual(failed?._tag === "Failed" ? failed.message : null, "boom");
  });

  it("starts empty", () => {
    assert.strictEqual(initialBoard.items.size, 0);
    assert.strictEqual(initialBoard.runs.size, 0);
    assert.strictEqual(initialBoard.workspaces.size, 0);
    assert.strictEqual(initialBoard.scheduler, null);
  });
});
