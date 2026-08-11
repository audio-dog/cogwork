import {
  ClassifiedItem,
  DaemonEvent,
  RunSummary,
  SchedulerStats,
  WorkspaceId,
} from "@clanker-forge/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { applyDaemonEvent, initialBoard } from "./board";

const workspace = Schema.decodeSync(WorkspaceId);
const classifiedItem = Schema.decodeSync(ClassifiedItem);
const runSummary = Schema.decodeSync(RunSummary);
const schedulerStats = Schema.decodeSync(SchedulerStats);
const event = Schema.decodeSync(DaemonEvent);

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

  it("keeps items with the same id apart across workspaces", () => {
    const board = fold([
      event({ _tag: "ItemChanged", workspace: "acme", item: eligible("1", "triage") }),
      event({ _tag: "ItemChanged", workspace: "beta", item: eligible("1", "verify") }),
    ]);

    assert.strictEqual(board.items.size, 2);
    assert.strictEqual(stageOf(board.items.get("acme::1")?.item), "triage");
    assert.strictEqual(stageOf(board.items.get("beta::1")?.item), "verify");
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

  it("starts empty", () => {
    assert.strictEqual(initialBoard.items.size, 0);
    assert.strictEqual(initialBoard.runs.size, 0);
    assert.strictEqual(initialBoard.scheduler, null);
  });
});
