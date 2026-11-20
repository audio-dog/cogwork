import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { WorkspaceId } from "./base-schemas";
import { applyDaemonEvent, initialBoard, liveOnly, workspaceFailureState } from "./board";
import { LocalContribution } from "./contribution";
import { ControlStore, SchedulerStats } from "./daemon";
import { DaemonEvent, ReadModelItem, WorkspaceState } from "./daemon-event";
import { HarnessReadiness } from "./harness";
import { RunSummary } from "./run";
import { defaultControlStore } from "./scheduler-defaults";

const workspace = Schema.decodeSync(WorkspaceId);
const readModelItem = Schema.decodeSync(ReadModelItem);
const runSummary = Schema.decodeSync(RunSummary);
const schedulerStats = Schema.decodeSync(SchedulerStats);
const controlStore = Schema.decodeSync(ControlStore);
const workspaceState = Schema.decodeSync(WorkspaceState);
const localContribution = Schema.decodeSync(LocalContribution);
const harnessReadiness = Schema.decodeSync(HarnessReadiness);
const decodeEvent = Schema.decodeUnknownSync(DaemonEvent);
const event = (value: Record<string, unknown>) => decodeEvent({ ...value, emittedAtMillis: 0 });

const registered = (id: string) =>
  workspaceState({
    _tag: "Registered",
    id,
    displayName: id,
    checkoutPath: `/repos/${id}`,
    issueTracker: "github",
    record: {
      displayName: id,
      checkoutPath: `/repos/${id}`,
      issueTracker: { type: "github" },
      linearHistory: false,
    },
    contributions: [],
  });

const readyToMerge = (id: string, title: string) =>
  readModelItem({
    _tag: "ReadyToMerge",
    id,
    title,
    url: null,
    pr: {
      number: Number(id.replace(/\D/g, "")) || 1,
      url: `https://example.test/pull/${id}`,
      checks: "passing",
      review: "ready",
      baseDivergence: "clean",
      waitingSinceMillis: 0,
    },
  });

const titleOf = (item: ReadModelItem | undefined) => item?.title ?? null;

const fold = (events: ReadonlyArray<DaemonEvent>) => events.reduce(applyDaemonEvent, initialBoard);

describe("applyDaemonEvent", () => {
  it("keeps a failed workspace registration name in live state", () => {
    const state = workspaceState(
      workspaceFailureState({
        id: workspace("0198f16a-21d7-7000-8000-000000000001"),
        displayName: "Cogwork",
        source: "/repos/cogwork",
        message: "Workspace input is missing",
      }),
    );

    assert.strictEqual(WorkspaceState.guards.Failed(state) ? state.displayName : undefined, "Cogwork");
  });

  it("requires emittedAtMillis on daemon events", () => {
    assert.throws(() => decodeEvent({ _tag: "SeedEnd" }));
  });

  it("records the latest read-model item per workspace and id", () => {
    const board = fold([
      event({ _tag: "ItemChanged", workspace: "acme", item: readyToMerge("1", "First") }),
      event({ _tag: "ItemChanged", workspace: "acme", item: readyToMerge("1", "Updated") }),
      event({ _tag: "ItemChanged", workspace: "acme", item: readyToMerge("2", "Second") }),
    ]);

    assert.strictEqual(board.items.size, 2);
    const first = board.items.get("acme::1");
    assert.strictEqual(first?.item._tag, "ReadyToMerge");
    assert.strictEqual(titleOf(first?.item), "Updated");
    assert.strictEqual(first?.workspace, workspace("acme"));
  });

  it("removes an item and leaves the rest of the board alone", () => {
    const board = fold([
      event({ _tag: "ItemChanged", workspace: "acme", item: readyToMerge("1", "First") }),
      event({ _tag: "ItemChanged", workspace: "acme", item: readyToMerge("2", "Second") }),
      event({ _tag: "ItemRemoved", workspace: "acme", id: "1" }),
    ]);

    assert.strictEqual(board.items.size, 1);
    assert.isUndefined(board.items.get("acme::1"));
    assert.strictEqual(titleOf(board.items.get("acme::2")?.item), "Second");
  });

  it("removes an item only in its own workspace", () => {
    const board = fold([
      event({ _tag: "ItemChanged", workspace: "acme", item: readyToMerge("1", "Acme") }),
      event({ _tag: "ItemChanged", workspace: "beta", item: readyToMerge("1", "Beta") }),
      event({ _tag: "ItemRemoved", workspace: "acme", id: "1" }),
    ]);

    assert.strictEqual(board.items.size, 1);
    assert.isUndefined(board.items.get("acme::1"));
    assert.strictEqual(titleOf(board.items.get("beta::1")?.item), "Beta");
  });

  it("tolerates removing an item the board never had", () => {
    const board = fold([event({ _tag: "ItemRemoved", workspace: "acme", id: "1" })]);
    assert.strictEqual(board.items.size, 0);
  });

  it("keeps items with the same id apart across workspaces", () => {
    const board = fold([
      event({ _tag: "ItemChanged", workspace: "acme", item: readyToMerge("1", "Acme") }),
      event({ _tag: "ItemChanged", workspace: "beta", item: readyToMerge("1", "Beta") }),
    ]);

    assert.strictEqual(board.items.size, 2);
    assert.strictEqual(titleOf(board.items.get("acme::1")?.item), "Acme");
    assert.strictEqual(titleOf(board.items.get("beta::1")?.item), "Beta");
  });

  it("is idempotent: applying the same event twice is harmless", () => {
    const changed = event({
      _tag: "ItemChanged",
      workspace: "acme",
      item: readyToMerge("1", "Implement"),
    });

    const once = applyDaemonEvent(initialBoard, changed);
    const twice = applyDaemonEvent(once, changed);

    assert.strictEqual(twice.items.size, 1);
    assert.strictEqual(titleOf(twice.items.get("acme::1")?.item), "Implement");
  });

  it("leaves the board unchanged for the SeedEnd subscription-control event", () => {
    const board = applyDaemonEvent(initialBoard, event({ _tag: "SeedEnd", emittedAtMillis: 1_000 }));

    assert.strictEqual(board, initialBoard);
  });

  it("does not retain an item that a new complete seed omits", () => {
    const firstSeed = fold([
      event({ _tag: "ItemChanged", workspace: "acme", item: readyToMerge("gone", "Gone") }),
    ]);
    const nextSeed = fold([
      event({ _tag: "ItemChanged", workspace: "acme", item: readyToMerge("kept", "Kept") }),
    ]);

    assert.strictEqual(firstSeed.items.has("acme::gone"), true);
    assert.strictEqual(nextSeed.items.has("acme::gone"), false);
    assert.strictEqual(nextSeed.items.has("acme::kept"), true);
  });

  it.effect("keeps only events after the SeedEnd boundary for live consumers", () =>
    Stream.fromIterable([
      event({ _tag: "ItemChanged", workspace: "acme", item: readyToMerge("seed", "Seed") }),
      event({ _tag: "SeedEnd", emittedAtMillis: 1_000 }),
      event({ _tag: "ItemChanged", workspace: "acme", item: readyToMerge("live", "Live") }),
    ]).pipe(
      liveOnly,
      Stream.runCollect,
      Effect.tap((events) =>
        Effect.sync(() =>
          assert.deepStrictEqual(
            [...events].map((event) => event._tag),
            ["ItemChanged"],
          ),
        ),
      ),
    ),
  );

  it("tracks the latest run summary and scheduler stats", () => {
    const run = runSummary({
      id: "run-1",
      workspace: "acme",
      workItem: "1",
      operation: "implement",
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
      perWorkspaceLimit: 4,
      dailyBudgetUsed: 2,
      dailyBudgetLimit: 10,
      perWorkspace: [{ id: "acme", inFlight: 1, limit: 3 }],
    });

    const board = fold([
      event({ _tag: "RunChanged", run }),
      event({ _tag: "SchedulerChanged", scheduler: stats }),
    ]);

    assert.strictEqual(board.runs.get("run-1")?.status, "running");
    assert.strictEqual(board.scheduler?.globalInFlight, 1);
  });

  it("tracks the latest whole Control store picture", () => {
    const first = controlStore({
      daemonLimits: {
        globalConcurrency: 4,
        perWorkspaceConcurrency: 4,
        dailyBudget: 50,
        revision: 0,
      },
      operationSettings: [],
      connections: [],
      pluginInstalls: [],
      contributionSettings: [],
    });
    const next = controlStore({
      daemonLimits: {
        globalConcurrency: 8,
        perWorkspaceConcurrency: 3,
        dailyBudget: 20,
        revision: 1,
      },
      operationSettings: [
        {
          setting: "model",
          level: { _tag: "Default" },
          scope: { _tag: "SettingsProfile" },
          value: "anthropic/claude-sonnet-4-5",
        },
      ],
      connections: [],
      pluginInstalls: [],
      contributionSettings: [],
    });

    const board = fold([
      event({ _tag: "ControlStoreChanged", controlStore: first }),
      event({ _tag: "ControlStoreChanged", controlStore: next }),
    ]);

    assert.deepStrictEqual(board.controlStore, next);
  });

  it("leaves Connection state to Connection events when the Control store changes", () => {
    const connected = fold([
      event({
        _tag: "ConnectionsChanged",
        connections: {
          connections: [
            {
              system: "linear",
              connection: {
                id: "linear/acme",
                system: "linear",
                account: "acme",
                status: "established",
              },
              readiness: { _tag: "Ready" },
            },
          ],
        },
        danglingWorkspaces: [],
      }),
    ]);
    const revoked = applyDaemonEvent(
      connected,
      event({
        _tag: "ControlStoreChanged",
        controlStore: controlStore({
          ...defaultControlStore,
          connections: [
            {
              id: "linear/acme",
              system: "linear",
              account: "acme",
              status: "revoked",
            },
          ],
        }),
      }),
    );

    assert.deepStrictEqual(revoked.connections, connected.connections);
  });

  it("replaces Plugin notices with the latest Plugin event", () => {
    const board = fold([
      event({
        _tag: "PluginsChanged",
        plugins: { plugins: [] },
        notices: ["GitHub remains connected."],
      }),
      event({ _tag: "PluginsChanged", plugins: { plugins: [] }, notices: [] }),
    ]);

    assert.deepStrictEqual(board.plugins, { plugins: [] });
    assert.deepStrictEqual(board.pluginNotices, []);
  });

  it("tracks the latest cached Harness readiness", () => {
    const readiness = harnessReadiness({
      checkedAtMillis: 12,
      harnesses: [
        {
          harness: "codex",
          enabled: true,
          version: "0.154.0",
          state: { _tag: "Ready" },
          diagnostics: ["Codex 0.155.0 is available."],
        },
      ],
    });

    const board = fold([event({ _tag: "HarnessesChanged", readiness })]);

    assert.deepStrictEqual(board.harnesses, readiness);
  });

  it("keeps running runs and only the recent settled run window", () => {
    const runs = Array.from({ length: 25 }, (_, index) =>
      event({
        _tag: "RunChanged",
        run: runSummary({
          id: `run-${index}`,
          workspace: "acme",
          workItem: "1",
          operation: "implement",
          harness: "cursor",
          branch: null,
          session: null,
          usage: null,
          status: "succeeded",
          startedAtMillis: index,
          endedAtMillis: index,
          eventCount: 0,
        }),
      }),
    );
    const board = fold([
      ...runs,
      event({
        _tag: "RunChanged",
        run: runSummary({
          id: "running",
          workspace: "acme",
          workItem: "1",
          operation: "implement",
          harness: "cursor",
          branch: null,
          session: null,
          usage: null,
          status: "running",
          startedAtMillis: 26,
          endedAtMillis: null,
          eventCount: 0,
        }),
      }),
    ]);

    assert.strictEqual(board.runs.has("running"), true);
    assert.strictEqual(board.runs.has("run-0"), false);
    assert.strictEqual(board.runs.has("run-24"), true);
  });

  it("records the latest workspace state per key, registered by id", () => {
    const board = fold([
      event({ _tag: "WorkspaceChanged", workspace: registered("acme") }),
      event({
        _tag: "WorkspaceChanged",
        workspace: workspaceState({
          _tag: "Registered",
          id: "acme",
          displayName: "acme",
          checkoutPath: "/repos/acme",
          issueTracker: "linear",
          record: {
            displayName: "acme",
            checkoutPath: "/repos/acme",
            issueTracker: { type: "linear" },
            linearHistory: false,
          },
          contributions: [],
        }),
      }),
    ]);

    assert.strictEqual(board.workspaces.size, 1);
    const acme = board.workspaces.get("acme");
    assert.strictEqual(acme?._tag, "Registered");
    assert.strictEqual(acme && WorkspaceState.guards.Registered(acme) ? acme.issueTracker : null, "linear");
  });

  it("folds Workspace input contribution offers into the registered workspace", () => {
    const contribution = localContribution({
      id: "local:repo/mcp/tools",
      authority: "local:repo",
      kind: "mcp-server",
      localName: "tools",
      file: "/repos/acme/.agents/mcp/tools.json",
    });
    const board = fold([
      event({
        _tag: "WorkspaceChanged",
        workspace: {
          ...registered("acme"),
          contributions: [contribution],
        },
      }),
    ]);

    const acme = board.workspaces.get("acme");
    assert.deepStrictEqual(acme && WorkspaceState.guards.Registered(acme) ? acme.contributions : [], [
      contribution,
    ]);
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
    assert.strictEqual(failed && WorkspaceState.guards.Failed(failed) ? failed.message : null, "boom");
  });

  it("replaces workspace states under their minted identity", () => {
    const failure = workspaceState({
      _tag: "Failed",
      id: "acme",
      source: "/repos/acme",
      message: "boom",
    });
    const failed = fold([
      event({ _tag: "WorkspaceChanged", workspace: registered("acme") }),
      event({ _tag: "WorkspaceChanged", workspace: failure }),
    ]);
    const recovered = applyDaemonEvent(
      failed,
      event({ _tag: "WorkspaceChanged", workspace: registered("acme") }),
    );

    assert.strictEqual(failed.workspaces.size, 1);
    assert.strictEqual(failed.workspaces.get("acme")?._tag, "Failed");
    assert.strictEqual(recovered.workspaces.size, 1);
    assert.strictEqual(recovered.workspaces.get("acme")?._tag, "Registered");
  });

  it("removes a deregistered workspace and its items", () => {
    const registeredBoard = fold([
      event({ _tag: "WorkspaceChanged", workspace: registered("acme") }),
      event({
        _tag: "ItemChanged",
        workspace: "acme",
        item: readyToMerge("#1", "Implement"),
      }),
    ]);

    const removed = applyDaemonEvent(registeredBoard, event({ _tag: "WorkspaceRemoved", workspace: "acme" }));

    assert.strictEqual(removed.workspaces.size, 0);
    assert.strictEqual(removed.items.size, 0);
  });

  it("starts empty", () => {
    assert.strictEqual(initialBoard.items.size, 0);
    assert.strictEqual(initialBoard.runs.size, 0);
    assert.strictEqual(initialBoard.workspaces.size, 0);
    assert.strictEqual(initialBoard.scheduler, null);
  });
});
