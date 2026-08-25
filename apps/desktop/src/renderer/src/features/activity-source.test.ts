import {
  type AgUiEvent,
  ClassifiedItem,
  DaemonEvent,
  RunSummary,
  SchedulerStats,
  WorkspaceState,
} from "@cogwork/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vitest";

const { subscribeEngineStatus } = vi.hoisted(() => ({ subscribeEngineStatus: vi.fn() }));

vi.mock("./use-engine-status", async () => {
  const actual = await vi.importActual<typeof import("./use-engine-status")>("./use-engine-status");
  return { ...actual, subscribeEngineStatus };
});

import {
  activeRuns,
  activityCategory,
  boundLog,
  decodeEvent,
  defaultActivityLimit,
  deriveActivityFeed,
  initialActivitySession,
  recordActivitySession,
  subscribeActivityFeed,
  synthesizeLifecycle,
} from "./activity-source";

const decodeDaemonEvent = Schema.decodeUnknownSync(DaemonEvent);
const event = (value: Record<string, unknown>) => decodeDaemonEvent({ ...value, emittedAtMillis: 0 });
const classifiedItem = Schema.decodeSync(ClassifiedItem);
const runSummary = Schema.decodeSync(RunSummary);
const schedulerStats = Schema.decodeSync(SchedulerStats);
const workspaceState = Schema.decodeSync(WorkspaceState);

const run = (over: Partial<Parameters<typeof runSummary>[0]> = {}) =>
  runSummary({
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

const scheduler = (over: Partial<Parameters<typeof schedulerStats>[0]> = {}) =>
  schedulerStats({
    scheduling: "running",
    globalInFlight: 2,
    globalLimit: 4,
    perWorkspaceLimit: 4,
    dailyBudgetUsed: 37,
    dailyBudgetLimit: 100,
    perWorkspace: [],
    ...over,
  });

const runActivity = (runId: string, seq: number, agui: AgUiEvent & { type: string }) =>
  event({
    _tag: "RunActivity",
    activity: {
      runId,
      workspace: "acme",
      workItem: "42",
      stage: "implement",
      seq,
      atMillis: seq,
      correlation: { threadId: null, messageId: null, toolCallId: agui.toolCallId ?? null },
      event: agui,
    },
  });

describe("decodeEvent — human summaries", () => {
  it("reads an item change as title → classified state", () => {
    const row = decodeEvent(
      event({
        _tag: "ItemChanged",
        workspace: "acme",
        item: classifiedItem({
          _tag: "Claimed",
          id: "42",
          title: "Add rate limiting",
          claim: { by: "agent", claimedAtMillis: 0 },
        }),
      }),
      1_000,
    );

    expect(row?.label).toBe("Item");
    expect(row?.summary).toBe("Add rate limiting → claimed");
    expect(row?.severity).toBe("info");
    expect(row?.entity).toEqual({ type: "item", id: "42", workspace: "acme" });
  });

  it("counts open blockers and reads needs-a-person", () => {
    const blocked = decodeEvent(
      event({
        _tag: "ItemChanged",
        workspace: "acme",
        item: classifiedItem({ _tag: "Blocked", id: "7", title: "Upgrade Effect", openBlockers: 2 }),
      }),
      1_000,
    );
    const needsHuman = decodeEvent(
      event({
        _tag: "ItemChanged",
        workspace: "acme",
        item: classifiedItem({
          _tag: "NeedsHuman",
          id: "9",
          title: "Emoji picker",
          reason: "needs-info",
          proposal: null,
          url: null,
        }),
      }),
      1_000,
    );

    expect(blocked?.summary).toBe("Upgrade Effect → blocked · 2 open");
    expect(blocked?.severity).toBe("warn");
    expect(needsHuman?.summary).toBe("Emoji picker → needs a person");
    expect(needsHuman?.severity).toBe("warn");
  });

  it("reads an item removal, carrying the item entity", () => {
    const row = decodeEvent(event({ _tag: "ItemRemoved", workspace: "acme", id: "42" }), 2_000);

    expect(row?.label).toBe("Item");
    expect(row?.summary).toBe("42 removed");
    expect(row?.severity).toBe("info");
    expect(row?.entity).toEqual({ type: "item", id: "42", workspace: "acme" });
  });

  it("reads a run milestone as work item · run status", () => {
    const row = decodeEvent(event({ _tag: "RunChanged", run: run({ status: "succeeded" }) }), 1_000);

    expect(row?.label).toBe("Run");
    expect(row?.summary).toBe("42 · run succeeded");
    expect(row?.entity).toMatchObject({
      type: "run",
      id: "run-1",
      workspace: "acme",
      workItem: "42",
      run: { id: "run-1", workItem: "42" },
    });
  });

  it("gives distinct run updates distinct row identities", () => {
    const inserted = decodeEvent(event({ _tag: "RunChanged", run: run({ eventCount: 0 }) }), 1_000);
    const attached = decodeEvent(event({ _tag: "RunChanged", run: run({ eventCount: 1 }) }), 1_000);

    expect(inserted?.id).not.toBe(attached?.id);
  });

  it("reads a registered workspace and a failed one", () => {
    const registered = decodeEvent(
      event({
        _tag: "WorkspaceChanged",
        workspace: workspaceState({
          _tag: "Registered",
          name: "acme",
          checkoutPath: "/repos/acme",
          issueTracker: "github",
          harness: "cursor",
          poll: { status: "ok" },
        }),
      }),
      1_000,
    );
    const failed = decodeEvent(
      event({
        _tag: "WorkspaceChanged",
        workspace: workspaceState({ _tag: "Failed", source: "web.workspace.ts", message: "clone timed out" }),
      }),
      1_000,
    );

    expect(registered?.summary).toBe("acme registered · github");
    expect(registered?.severity).toBe("info");
    expect(failed?.summary).toBe("web.workspace.ts failed · clone timed out");
    expect(failed?.severity).toBe("error");
  });

  it("reads a scheduler tick with in-flight and budget", () => {
    const row = decodeEvent(event({ _tag: "SchedulerChanged", scheduler: scheduler() }), 1_000);

    expect(row?.label).toBe("Scheduler");
    expect(row?.summary).toBe("2/4 in flight · budget 37/100");
    expect(row?.severity).toBe("info");
  });
});

describe("activityCategory", () => {
  it("groups items and system lifecycle events for the shared funnel", () => {
    expect(activityCategory("item")).toBe("item");
    expect(activityCategory("item-removed")).toBe("item");
    expect(activityCategory("engine")).toBe("system");
    expect(activityCategory("connection")).toBe("system");
    expect(activityCategory("stream")).toBe("system");
  });
});

describe("decodeEvent — severity mapping", () => {
  it("maps each run outcome to a severity", () => {
    const severityOf = (status: Parameters<typeof runSummary>[0]["status"]) =>
      decodeEvent(event({ _tag: "RunChanged", run: run({ status }) }), 0)?.severity;

    expect(severityOf("running")).toBe("info");
    expect(severityOf("succeeded")).toBe("success");
    expect(severityOf("failed")).toBe("error");
    expect(severityOf("crashed")).toBe("error");
    expect(severityOf("exhausted")).toBe("warn");
    expect(severityOf("interrupted")).toBe("warn");
  });
});

describe("decodeEvent — low-signal classification", () => {
  it("marks eligible item churn low-signal, but not other item states", () => {
    const eligible = decodeEvent(
      event({
        _tag: "ItemChanged",
        workspace: "acme",
        item: classifiedItem({ _tag: "Eligible", id: "1", title: "Tidy the fold", stage: "implement" }),
      }),
      0,
    );
    const claimed = decodeEvent(
      event({
        _tag: "ItemChanged",
        workspace: "acme",
        item: classifiedItem({
          _tag: "Claimed",
          id: "1",
          title: "Tidy the fold",
          claim: { by: "agent", claimedAtMillis: 0 },
        }),
      }),
      0,
    );

    expect(eligible?.lowSignal).toBe(true);
    expect(claimed?.lowSignal).toBe(false);
  });

  it("marks item removals low-signal", () => {
    expect(decodeEvent(event({ _tag: "ItemRemoved", workspace: "acme", id: "1" }), 0)?.lowSignal).toBe(true);
  });

  it("keeps a paused scheduler tick visible, warn, and re-worded", () => {
    const row = decodeEvent(
      event({ _tag: "SchedulerChanged", scheduler: scheduler({ scheduling: "paused" }) }),
      0,
    );

    expect(row?.summary).toBe("paused · 2/4 in flight");
    expect(row?.severity).toBe("warn");
    expect(row?.lowSignal).toBe(false);
  });

  it("marks a steady, non-paused scheduler tick low-signal", () => {
    expect(decodeEvent(event({ _tag: "SchedulerChanged", scheduler: scheduler() }), 0)?.lowSignal).toBe(true);
  });
});

describe("synthesizeLifecycle — transition-only", () => {
  it("emits nothing while nothing changes", () => {
    const rows = synthesizeLifecycle([
      { engine: "up", connection: "live", atMillis: 1 },
      { engine: "up", connection: "live", atMillis: 2 },
      { engine: "up", connection: "live", atMillis: 3 },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows.map((r) => r.summary)).toEqual(["Connection restored"]);
  });

  it("does not synthesize engine stopped on first sample when engine is off", () => {
    const rows = synthesizeLifecycle([{ engine: "off", connection: "connecting", atMillis: 1 }]);

    expect(rows).toHaveLength(0);
  });

  it("emits one row per real transition, with the right severity", () => {
    const rows = synthesizeLifecycle([
      { engine: "starting", connection: "connecting", atMillis: 1 },
      { engine: "up", connection: "live", atMillis: 2 },
      { engine: "off", connection: "connecting", atMillis: 3 },
      { engine: "failed", connection: "lost", atMillis: 4 },
    ]);

    expect(rows.map((r) => ({ summary: r.summary, severity: r.severity, kind: r.kind }))).toEqual([
      { summary: "Engine started", severity: "success", kind: "engine" },
      { summary: "Connection restored", severity: "info", kind: "connection" },
      { summary: "Engine stopped", severity: "warn", kind: "engine" },
      { summary: "Connecting…", severity: "info", kind: "connection" },
      { summary: "Engine failed", severity: "error", kind: "engine" },
      { summary: "Event stream disconnected", severity: "error", kind: "stream" },
    ]);
  });

  it("marks a connecting heartbeat low-signal, a drop and a restore not", () => {
    const rows = synthesizeLifecycle([
      { engine: "up", connection: "live", atMillis: 1 },
      { engine: "up", connection: "connecting", atMillis: 2 },
      { engine: "up", connection: "lost", atMillis: 3 },
      { engine: "up", connection: "live", atMillis: 4 },
    ]);
    const bySummary = (summary: string) => rows.find((r) => r.summary === summary);

    expect(bySummary("Connecting…")?.lowSignal).toBe(true);
    expect(bySummary("Event stream disconnected")?.lowSignal).toBe(false);
    expect(bySummary("Connection restored")?.lowSignal).toBe(false);
  });
});

describe("timestamps — arrival vs real", () => {
  it("stamps a run row with the run's own time, not the arrival stamp", () => {
    const ended = decodeEvent(
      event({ _tag: "RunChanged", run: run({ status: "succeeded", endedAtMillis: 555 }) }),
      9_999,
    );
    const running = decodeEvent(event({ _tag: "RunChanged", run: run({ startedAtMillis: 111 }) }), 9_999);

    expect(ended?.atMillis).toBe(555);
    expect(running?.atMillis).toBe(111);
  });

  it("stamps non-run rows with the arrival stamp", () => {
    const row = decodeEvent(event({ _tag: "ItemRemoved", workspace: "acme", id: "1" }), 4_242);
    expect(row?.atMillis).toBe(4_242);
  });
});

describe("activeRuns — one row per run", () => {
  it("never emits a per-delta log row for run activity", () => {
    expect(decodeEvent(runActivity("run-1", 0, { type: "TEXT_MESSAGE_CONTENT", delta: "hi" }), 0)).toBeNull();
  });

  it("collapses a run to one live row carrying its preview", () => {
    const runs = activeRuns([
      event({ _tag: "RunChanged", run: run({ id: "run-1", status: "running" }) }),
      runActivity("run-1", 0, { type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "grep" }),
      runActivity("run-1", 1, { type: "TOOL_CALL_END", toolCallId: "t1", result: "12 matches" }),
    ]);

    expect(runs).toHaveLength(1);
    expect(runs[0].runId).toBe("run-1");
    expect(runs[0].preview).toEqual({ label: "grep", text: "12 matches" });
  });

  it("keeps only running runs, newest first", () => {
    const runs = activeRuns([
      event({ _tag: "RunChanged", run: run({ id: "old", status: "running", startedAtMillis: 1 }) }),
      event({ _tag: "RunChanged", run: run({ id: "new", status: "running", startedAtMillis: 2 }) }),
      event({ _tag: "RunChanged", run: run({ id: "done", status: "succeeded", startedAtMillis: 3 }) }),
    ]);

    expect(runs.map((r) => r.runId)).toEqual(["new", "old"]);
  });
});

describe("boundLog — bounded buffer", () => {
  const rows = Array.from({ length: 10 }, (_, i) =>
    decodeEvent(event({ _tag: "ItemRemoved", workspace: "acme", id: `${i}` }), i),
  ).filter((row): row is NonNullable<typeof row> => row !== null);

  it("keeps the newest rows when over the limit", () => {
    const bounded = boundLog(rows, 3);
    expect(bounded.map((r) => r.summary)).toEqual(["7 removed", "8 removed", "9 removed"]);
  });

  it("keeps everything when under the limit", () => {
    expect(boundLog(rows, 100)).toHaveLength(10);
  });

  it("keeps nothing for a non-positive limit", () => {
    expect(boundLog(rows, 0)).toHaveLength(0);
  });
});

describe("deriveActivityFeed — the unified fold", () => {
  it("merges daemon rows and synthesized rows in time order", () => {
    const feed = deriveActivityFeed({
      events: [
        event({ _tag: "ItemRemoved", workspace: "acme", id: "1" }),
        event({ _tag: "RunChanged", run: run({ status: "succeeded", endedAtMillis: 50 }) }),
      ],
      arrivals: [200, 999],
      synthesized: synthesizeLifecycle([{ engine: "up", connection: "live", atMillis: 100 }]),
      engine: "up",
      connection: "live",
    });

    expect(feed.log.map((r) => r.summary)).toEqual([
      "42 · run succeeded",
      "Connection restored",
      "1 removed",
    ]);
    expect(feed.total).toBe(3);
  });

  it("reports the live Now-zone and bounds the log", () => {
    const feed = deriveActivityFeed({
      events: [
        event({ _tag: "RunChanged", run: run({ id: "run-1", status: "running", startedAtMillis: 1 }) }),
        event({ _tag: "SchedulerChanged", scheduler: scheduler({ globalInFlight: 3 }) }),
        event({ _tag: "ItemRemoved", workspace: "acme", id: "a" }),
        event({ _tag: "ItemRemoved", workspace: "acme", id: "b" }),
      ],
      arrivals: [1, 2, 3, 4],
      synthesized: [],
      engine: "up",
      connection: "live",
      limit: 1,
    });

    expect(feed.now.engine).toBe("up");
    expect(feed.now.scheduler?.globalInFlight).toBe(3);
    expect(feed.now.runs.map((r) => r.runId)).toEqual(["run-1"]);
    expect(feed.total).toBe(4);
    expect(feed.log).toHaveLength(1);
    expect(feed.log[0].summary).toBe("b removed");
  });
});

describe("recordActivitySession", () => {
  it("keeps session storage bounded to the transcript limit", () => {
    const events = Array.from({ length: defaultActivityLimit + 1 }, (_, index) =>
      event({ _tag: "ItemRemoved", workspace: "acme", id: `${index}` }),
    );

    const session = recordActivitySession(initialActivitySession, {
      events,
      engine: "up",
      connection: "live",
      atMillis: 100,
    });

    expect(session.events).toEqual(events.slice(1));
    expect(session.eventKeys).toHaveLength(defaultActivityLimit);
    expect(session.arrivals).toHaveLength(defaultActivityLimit);
  });

  it("records the first engine transition after a quiet initial sample", () => {
    const initialized = recordActivitySession(initialActivitySession, {
      events: [],
      engine: "off",
      connection: "connecting",
      atMillis: 100,
    });
    const started = recordActivitySession(initialized, {
      events: [],
      engine: "up",
      connection: "connecting",
      atMillis: 200,
    });

    expect(initialized.lifecycle.engine).toBe("off");
    expect(started.synthesized.map((row) => row.summary)).toEqual(["Engine started"]);
  });

  it("keeps arrival times correct when a fresh event stream replaces the prior one", () => {
    const first = event({ _tag: "ItemRemoved", workspace: "acme", id: "first" });
    const second = event({ _tag: "ItemRemoved", workspace: "acme", id: "second" });
    const afterFirst = recordActivitySession(initialActivitySession, {
      events: [first],
      engine: "up",
      connection: "live",
      atMillis: 100,
    });
    const afterReconnect = recordActivitySession(afterFirst, {
      events: [second],
      engine: "up",
      connection: "live",
      atMillis: 200,
    });

    expect(afterReconnect.arrivals).toEqual([100, 200]);
    expect(afterReconnect.events).toEqual([first, second]);
  });

  it("does not append matching reconnect seed events", () => {
    const first = event({ _tag: "ItemRemoved", workspace: "acme", id: "first" });
    const reseeded = event({ _tag: "ItemRemoved", workspace: "acme", id: "first" });
    const session = recordActivitySession(initialActivitySession, {
      events: [first],
      engine: "up",
      connection: "live",
      atMillis: 100,
    });

    expect(
      recordActivitySession(session, {
        events: [reseeded],
        engine: "up",
        connection: "live",
        atMillis: 200,
      }).events,
    ).toEqual([first]);
  });

  it("records repeated event payloads from one live stream", () => {
    const repeated = event({ _tag: "ItemRemoved", workspace: "acme", id: "first" });
    const first = recordActivitySession(initialActivitySession, {
      events: [repeated],
      engine: "up",
      connection: "live",
      atMillis: 100,
    });

    expect(
      recordActivitySession(first, {
        events: [repeated, repeated],
        engine: "up",
        connection: "live",
        atMillis: 200,
      }).events,
    ).toEqual([repeated, repeated]);
  });

  it("keeps the stream cursor through an engine-status sample", () => {
    const repeated = event({ _tag: "ItemRemoved", workspace: "acme", id: "first" });
    const first = recordActivitySession(initialActivitySession, {
      events: [repeated],
      engine: "up",
      connection: "live",
      atMillis: 100,
    });
    const afterEngineStatus = recordActivitySession(first, {
      events: null,
      engine: "off",
      connection: "live",
      atMillis: 150,
    });

    expect(
      recordActivitySession(afterEngineStatus, {
        events: [repeated, repeated],
        engine: "off",
        connection: "live",
        atMillis: 200,
      }).events,
    ).toEqual([repeated, repeated]);
  });
});

describe("subscribeActivityFeed", () => {
  it("does not notify its listener during subscription", () => {
    subscribeEngineStatus.mockImplementation((listener) => {
      listener("running");
      return () => undefined;
    });
    const listener = vi.fn();

    const unsubscribe = subscribeActivityFeed(listener);

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});
