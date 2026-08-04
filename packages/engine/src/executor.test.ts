import {
  HarnessName,
  SessionId,
  type TokenUsage,
  WorkItemId,
  WorkspaceConfig,
} from "@clanker-forge/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Executor from "./executor";
import { GitError } from "./git";
import {
  HarnessError,
  type HarnessEvent,
  type HarnessRequest,
  type HarnessRunner,
  layer as harnessLayer,
} from "./harness";
import { IssueTracker, type IssueTrackerService } from "./issue-tracker";
import type { RegisteredWorkspace } from "./projector";
import * as RunEventBus from "./run-event-bus";
import * as RunLedger from "./run-ledger";
import { branchName, WorktreeDivergedError, WorktreeManager, type WorktreeManagerService } from "./worktree";

const cursor = Schema.decodeSync(HarnessName)("cursor");
const id = Schema.decodeSync(WorkItemId);
const previousSession = Schema.decodeSync(SessionId)("sess-prev");

const workspace: RegisteredWorkspace = {
  source: "gh.workspace.ts",
  config: Schema.decodeSync(WorkspaceConfig)({
    name: "gh",
    checkoutPath: "/repos/gh",
    issueTracker: { type: "github", repo: "owner/repo", botLogin: "clanker-bot" },
    harness: { preferred: "cursor" },
    playbook: { triage: { enabled: true } },
  }),
};

const triageItem = { id: id("#7"), title: "broken export", stage: "triage" as const, priorFailures: 0 };

const usage: TokenUsage = { inputTokens: 12, outputTokens: 34, totalTokens: 46 };

const implementWorkspace: RegisteredWorkspace = {
  source: workspace.source,
  config: Schema.decodeSync(WorkspaceConfig)({
    name: "gh",
    checkoutPath: "/repos/gh",
    issueTracker: { type: "github", repo: "owner/repo", botLogin: "clanker-bot" },
    harness: { preferred: "cursor" },
    playbook: { implement: { enabled: true } },
  }),
};

const mcpWorkspace: RegisteredWorkspace = {
  source: workspace.source,
  config: Schema.decodeSync(WorkspaceConfig)({
    name: "gh",
    checkoutPath: "/repos/gh",
    issueTracker: { type: "github", repo: "owner/repo", botLogin: "clanker-bot" },
    harness: { preferred: "cursor" },
    mcpSkills: [{ name: "linear", endpoint: "https://mcp.linear.app/mcp/readonly" }],
    playbook: { implement: { enabled: true } },
  }),
};

const implementItem = {
  id: id("#15"),
  title: "Implement playbook",
  stage: "implement" as const,
  priorFailures: 0,
};

const implementBranch = branchName(implementItem);

const implementStreamEvents: ReadonlyArray<HarnessEvent> = [
  { type: "RUN_STARTED", name: null, text: null, sessionId: null, usage: null, finishReason: null },
  { type: "CUSTOM", name: "session", text: null, sessionId: "sess-42", usage: null, finishReason: null },
  {
    type: "TEXT_MESSAGE_CONTENT",
    name: null,
    text: "Opened PR #99, Closes #15.\nIMPLEMENT-RESULT: opened-pr",
    sessionId: null,
    usage: null,
    finishReason: null,
  },
];

const implementFinished: HarnessEvent = {
  type: "RUN_FINISHED",
  name: null,
  text: null,
  sessionId: null,
  usage,
  finishReason: "stop",
};

const implementEvents: ReadonlyArray<HarnessEvent> = [...implementStreamEvents, implementFinished];

const stuckImplementEvents: ReadonlyArray<HarnessEvent> = [
  { type: "RUN_STARTED", name: null, text: null, sessionId: null, usage: null, finishReason: null },
  {
    type: "TEXT_MESSAGE_CONTENT",
    name: null,
    text: "The brief contradicts itself; leaving for a human.\nIMPLEMENT-RESULT: stuck",
    sessionId: null,
    usage: null,
    finishReason: null,
  },
  { type: "RUN_FINISHED", name: null, text: null, sessionId: null, usage, finishReason: "stop" },
];

const gatedRunner = (release: Deferred.Deferred<void>): HarnessRunner => ({
  name: cursor,
  run: () =>
    Stream.concat(
      Stream.fromArray(implementStreamEvents),
      Stream.unwrap(Deferred.await(release).pipe(Effect.map(() => Stream.fromArray([implementFinished])))),
    ),
});

const noSentinelImplementEvents: ReadonlyArray<HarnessEvent> = [
  { type: "RUN_STARTED", name: null, text: null, sessionId: null, usage: null, finishReason: null },
  { type: "CUSTOM", name: "session", text: null, sessionId: "sess-42", usage: null, finishReason: null },
  {
    type: "TEXT_MESSAGE_CONTENT",
    name: null,
    text: "Made progress but ran out of turn before opening a PR.",
    sessionId: null,
    usage: null,
    finishReason: null,
  },
  { type: "RUN_FINISHED", name: null, text: null, sessionId: null, usage, finishReason: "stop" },
];

const followUpWorkspace: RegisteredWorkspace = {
  source: workspace.source,
  config: Schema.decodeSync(WorkspaceConfig)({
    name: "gh",
    checkoutPath: "/repos/gh",
    issueTracker: { type: "github", repo: "owner/repo", botLogin: "clanker-bot" },
    harness: { preferred: "cursor" },
    playbook: { "follow-up": { enabled: true } },
  }),
};

const followUpItem = {
  id: id("#5"),
  title: "PR follow-up playbook",
  stage: "follow-up" as const,
  priorFailures: 0,
  followUp: {
    checks: "failing" as const,
    humanCommentAtMillis: 0,
    noProgress: 0,
    stalled: false,
    fresh: false,
    baseDivergence: "none" as const,
  },
};

const followUpBranch = branchName(followUpItem);

const followUpEvents: ReadonlyArray<HarnessEvent> = [
  { type: "RUN_STARTED", name: null, text: null, sessionId: null, usage: null, finishReason: null },
  { type: "CUSTOM", name: "session", text: null, sessionId: "sess-42", usage: null, finishReason: null },
  {
    type: "TEXT_MESSAGE_CONTENT",
    name: null,
    text: "Fixed the failing check and pushed.\nFOLLOWUP-RESULT: pushed",
    sessionId: null,
    usage: null,
    finishReason: null,
  },
  { type: "RUN_FINISHED", name: null, text: null, sessionId: null, usage, finishReason: "stop" },
];

const disabledWorkspace: RegisteredWorkspace = {
  source: workspace.source,
  config: Schema.decodeSync(WorkspaceConfig)({
    name: "gh",
    checkoutPath: "/repos/gh",
    issueTracker: { type: "github", repo: "owner/repo" },
    harness: { preferred: "cursor" },
  }),
};

interface Call {
  readonly method: string;
  readonly item: string;
  readonly body?: string;
  readonly add?: ReadonlyArray<string>;
  readonly remove?: ReadonlyArray<string>;
  readonly outcome?: string;
  readonly checks?: string;
  readonly reason?: string;
}

const record = (calls: Ref.Ref<ReadonlyArray<Call>>, entry: Call) =>
  Ref.update(calls, (xs) => [...xs, entry]);

const recorder = (calls: Ref.Ref<ReadonlyArray<Call>>): IssueTrackerService => ({
  rateLimitScope: () => null,
  observe: () => Effect.succeed([]),
  claim: (_workspace, itemId) => record(calls, { method: "claim", item: itemId }),
  release: (_workspace, itemId) => record(calls, { method: "release", item: itemId }),
  recordAttempt: (_workspace, itemId, attempt, reason) =>
    record(calls, {
      method: "recordAttempt",
      item: itemId,
      outcome: attempt.outcome,
      reason,
    }),
  recordFollowUp: (_workspace, itemId, marker, detail) =>
    record(calls, { method: "recordFollowUp", item: itemId, checks: marker.checks, body: detail }),
  note: (_workspace, itemId, detail) => record(calls, { method: "note", item: itemId, body: detail }),
  setRoles: (_workspace, itemId, changes) =>
    record(calls, { method: "setRoles", item: itemId, add: changes.add, remove: changes.remove }),
});

const runner = (events: ReadonlyArray<HarnessEvent>): HarnessRunner => ({
  name: cursor,
  run: () => Stream.fromArray(events),
});

const capturingRunner = (
  requests: Ref.Ref<ReadonlyArray<HarnessRequest>>,
  events: ReadonlyArray<HarnessEvent>,
  tail: Stream.Stream<HarnessEvent, HarnessError> = Stream.empty,
): HarnessRunner => ({
  name: cursor,
  run: (request) =>
    Stream.unwrap(
      Ref.update(requests, (xs) => [...xs, request]).pipe(
        Effect.map(() => Stream.concat(Stream.fromArray(events), tail)),
      ),
    ),
});

const worktreeStubCreated = (created: boolean): WorktreeManagerService => ({
  ensure: (_workspace, item) =>
    Effect.succeed({ branch: branchName(item), path: `/wt/${branchName(item)}`, created }),
  list: () => Effect.succeed([]),
  remove: () => Effect.void,
  reconcile: () => Effect.succeed({ tornDown: [], reaped: [] }),
});

const worktreeStub = worktreeStubCreated(true);

const resumeRecordingWorktree = (ensured: Ref.Ref<ReadonlyArray<boolean>>): WorktreeManagerService => ({
  ensure: (_workspace, item, options) =>
    Ref.update(ensured, (xs) => [...xs, options?.resume ?? false]).pipe(
      Effect.map(() => ({ branch: branchName(item), path: `/wt/${branchName(item)}`, created: false })),
    ),
  list: () => Effect.succeed([]),
  remove: () => Effect.void,
  reconcile: () => Effect.succeed({ tornDown: [], reaped: [] }),
});

const divergedWorktree: WorktreeManagerService = {
  ...worktreeStub,
  ensure: (_workspace, item) =>
    Effect.fail(
      new WorktreeDivergedError({
        remote: "origin",
        branch: branchName(item),
        message: "branch has diverged from origin and replaying the local commits failed",
      }),
    ),
};

const unreachableRemoteWorktree: WorktreeManagerService = {
  ...worktreeStub,
  ensure: () =>
    Effect.fail(new GitError({ command: "fetch origin", message: "could not resolve host github.com" })),
};

const failingRunner = (error: HarnessError): HarnessRunner => ({
  name: cursor,
  run: () => Stream.fail(error),
});

const successEvents: ReadonlyArray<HarnessEvent> = [
  { type: "RUN_STARTED", name: null, text: null, sessionId: null, usage: null, finishReason: null },
  { type: "CUSTOM", name: "session", text: null, sessionId: "sess-42", usage: null, finishReason: null },
  {
    type: "TEXT_MESSAGE_CONTENT",
    name: null,
    text: "This is a genuine bug in the exporter. ",
    sessionId: null,
    usage: null,
    finishReason: null,
  },
  {
    type: "TEXT_MESSAGE_CONTENT",
    name: null,
    text: "\n\nTRIAGE-DECISION: ready-for-agent",
    sessionId: null,
    usage: null,
    finishReason: null,
  },
  { type: "RUN_FINISHED", name: null, text: null, sessionId: null, usage, finishReason: "stop" },
];

const provide = (
  ws: IssueTrackerService,
  runners: ReadonlyArray<HarnessRunner>,
  worktree: WorktreeManagerService = worktreeStub,
) =>
  Executor.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(IssueTracker, ws),
        harnessLayer(runners),
        RunLedger.layerMemory,
        RunEventBus.layer,
        Layer.succeed(WorktreeManager, worktree),
      ),
    ),
  );

describe("Executor.execute", () => {
  it.effect("triages an eligible item into a proposal note, label advance, and ledgered run", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
      const layer = provide(recorder(calls), [runner(successEvents)]);
      yield* Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        yield* executor.execute(workspace, triageItem);

        const log = yield* Ref.get(calls);
        const note = log.find((c) => c.method === "note");
        assert.isDefined(note);
        assert.include(note?.body ?? "", "genuine bug in the exporter");
        assert.notInclude(note?.body ?? "", "TRIAGE-DECISION");
        assert.include(note?.body ?? "", "generated by AI");

        const roles = log.find((c) => c.method === "setRoles");
        assert.deepStrictEqual(roles?.remove, ["needs-triage"]);
        assert.deepStrictEqual(roles?.add, ["ready-for-agent"]);

        const attempt = log.find((c) => c.method === "recordAttempt");
        assert.strictEqual(attempt?.outcome, "succeeded");
        assert.isTrue(log.some((c) => c.method === "release"));

        const ledger = yield* RunLedger.RunLedger;
        const runs = yield* ledger.listRuns(10);
        assert.strictEqual(runs.length, 1);
        const [firstRun] = runs;
        assert.isDefined(firstRun);
        assert.strictEqual(firstRun?.status, "succeeded");
        assert.strictEqual(firstRun?.session, "sess-42");
        assert.deepStrictEqual(firstRun?.usage, usage);
        assert.strictEqual(firstRun?.eventCount, successEvents.length);

        const events = firstRun ? yield* ledger.events(firstRun.id) : [];
        assert.strictEqual(events.length, successEvents.length);
        assert.deepStrictEqual(
          events.map((e) => e.seq),
          successEvents.map((_, i) => i),
        );
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("defaults an unparseable decision to ready-for-human but still posts the proposal", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
      const noDecision: ReadonlyArray<HarnessEvent> = [
        {
          type: "TEXT_MESSAGE_CONTENT",
          name: null,
          text: "I could not tell what to do.",
          sessionId: null,
          usage: null,
          finishReason: null,
        },
      ];
      const layer = provide(recorder(calls), [runner(noDecision)]);
      yield* Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        yield* executor.execute(workspace, triageItem);
        const log = yield* Ref.get(calls);
        assert.deepStrictEqual(log.find((c) => c.method === "setRoles")?.add, ["ready-for-human"]);
        assert.isTrue(log.some((c) => c.method === "note"));
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("backstops a missing sentinel with the proposal disposition", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
      const dispositionOnly: ReadonlyArray<HarnessEvent> = [
        {
          type: "TEXT_MESSAGE_CONTENT",
          name: null,
          text: "## Triage proposal\n\n**Disposition:** ready-for-agent\n\n### Open questions\n\n- none",
          sessionId: null,
          usage: null,
          finishReason: null,
        },
      ];
      const layer = provide(recorder(calls), [runner(dispositionOnly)]);
      yield* Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        yield* executor.execute(workspace, triageItem);
        const log = yield* Ref.get(calls);
        assert.deepStrictEqual(log.find((c) => c.method === "setRoles")?.add, ["ready-for-agent"]);
        assert.isTrue(log.some((c) => c.method === "note"));
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("marks a non-retryable harness failure as exhausted and hands it to a human", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
      const error = new HarnessError({ reason: "launch", retryable: false, message: "no cli" });
      const layer = provide(recorder(calls), [failingRunner(error)]);
      yield* Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        yield* executor.execute(workspace, triageItem);

        const log = yield* Ref.get(calls);
        const attempt = log.find((c) => c.method === "recordAttempt");
        assert.strictEqual(attempt?.outcome, "failed");
        assert.strictEqual(attempt?.reason, "no cli");
        assert.deepStrictEqual(log.find((c) => c.method === "setRoles")?.add, ["ready-for-human"]);
        const note = log.find((c) => c.method === "note");
        assert.include(note?.body ?? "", "non-retryable failure");
        assert.include(note?.body ?? "", "no cli");

        const ledger = yield* RunLedger.RunLedger;
        const runs = yield* ledger.listRuns(10);
        assert.strictEqual(runs[0]?.status, "exhausted");
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("records a retryable failure as an attempt without a handoff note", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
      const error = new HarnessError({ reason: "turn", retryable: true, message: "network blip" });
      const layer = provide(recorder(calls), [failingRunner(error)]);
      yield* Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        yield* executor.execute(workspace, triageItem);

        const log = yield* Ref.get(calls);
        const attempt = log.find((c) => c.method === "recordAttempt");
        assert.strictEqual(attempt?.outcome, "failed");
        assert.strictEqual(attempt?.reason, "network blip");
        assert.isFalse(log.some((c) => c.method === "setRoles"));
        assert.isFalse(log.some((c) => c.method === "note"));

        const ledger = yield* RunLedger.RunLedger;
        const runs = yield* ledger.listRuns(10);
        assert.strictEqual(runs[0]?.status, "failed");
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("persists a terminal event on failure so watchers flush the run", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
      const error = new HarnessError({ reason: "turn", retryable: true, message: "network blip" });
      const layer = provide(recorder(calls), [failingRunner(error)]);
      yield* Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        yield* executor.execute(workspace, triageItem);

        const ledger = yield* RunLedger.RunLedger;
        const runs = yield* ledger.listRuns(10);
        const id = runs[0]?.id;
        const events = id ? yield* ledger.events(id) : [];
        assert.isTrue(events.some((event) => event.type === "RUN_FINISHED"));
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("exhausts a retryable failure once its attempt reaches the cap", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
      const error = new HarnessError({ reason: "turn", retryable: true, message: "network blip" });
      const layer = provide(recorder(calls), [failingRunner(error)]);
      const atCap = { ...triageItem, priorFailures: 2 };
      yield* Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        yield* executor.execute(workspace, atCap);

        const log = yield* Ref.get(calls);
        assert.strictEqual(log.find((c) => c.method === "recordAttempt")?.outcome, "failed");
        assert.deepStrictEqual(log.find((c) => c.method === "setRoles")?.add, ["ready-for-human"]);
        assert.include(log.find((c) => c.method === "note")?.body ?? "", "3 failed triage attempts");

        const ledger = yield* RunLedger.RunLedger;
        const runs = yield* ledger.listRuns(10);
        assert.strictEqual(runs[0]?.status, "exhausted");
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("treats an unregistered harness as a non-retryable, human-handoff failure", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
      const layer = provide(recorder(calls), []);
      yield* Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        yield* executor.execute(workspace, triageItem);
        const log = yield* Ref.get(calls);
        assert.deepStrictEqual(log.find((c) => c.method === "setRoles")?.add, ["ready-for-human"]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("does nothing when triage is disabled in the playbook", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
      const layer = provide(recorder(calls), [runner(successEvents)]);
      yield* Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        yield* executor.execute(disabledWorkspace, triageItem);
        assert.deepStrictEqual(yield* Ref.get(calls), []);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("runs an implement job in the worktree and ledgers the run keyed by branch", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
      const requests = yield* Ref.make<ReadonlyArray<HarnessRequest>>([]);
      const layer = provide(recorder(calls), [capturingRunner(requests, implementEvents)]);
      yield* Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        yield* executor.execute(implementWorkspace, implementItem);

        const [request] = yield* Ref.get(requests);
        assert.strictEqual(request?.checkoutPath, `/wt/${implementBranch}`);
        assert.include(request?.prompt ?? "", "implement-agent");
        assert.include(request?.prompt ?? "", "#15");
        assert.isNull(request?.sessionId ?? null);
        assert.deepStrictEqual(request?.mcpSkills, []);

        const log = yield* Ref.get(calls);
        assert.strictEqual(log.find((c) => c.method === "recordAttempt")?.outcome, "succeeded");
        assert.isTrue(log.some((c) => c.method === "release"));
        assert.isFalse(log.some((c) => c.method === "note"));
        const roles = log.find((c) => c.method === "setRoles");
        assert.deepStrictEqual(roles?.remove, ["ready-for-agent"]);
        assert.deepStrictEqual(roles?.add, []);

        const ledger = yield* RunLedger.RunLedger;
        const [run] = yield* ledger.listRuns(10);
        assert.strictEqual(run?.stage, "implement");
        assert.strictEqual(run?.branch, implementBranch);
        assert.strictEqual(run?.status, "succeeded");
        assert.strictEqual(run?.session, "sess-42");
        assert.deepStrictEqual(run?.usage, usage);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("hands the workspace's MCP skills to the harness on the run request", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
      const requests = yield* Ref.make<ReadonlyArray<HarnessRequest>>([]);
      const layer = provide(recorder(calls), [capturingRunner(requests, implementEvents)]);
      yield* Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        yield* executor.execute(mcpWorkspace, implementItem);

        const [request] = yield* Ref.get(requests);
        assert.deepStrictEqual(request?.mcpSkills, [
          { name: "linear", endpoint: "https://mcp.linear.app/mcp/readonly" },
        ]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("ledgers the session while the run is still in flight", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
      const release = yield* Deferred.make<void>();
      const layer = provide(recorder(calls), [gatedRunner(release)]);
      yield* Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        const ledger = yield* RunLedger.RunLedger;
        const bus = yield* RunEventBus.RunEventBus;
        const subscription = yield* bus.subscribe();
        const running = yield* Effect.forkChild(executor.execute(implementWorkspace, implementItem));

        yield* Stream.fromSubscription(subscription).pipe(
          Stream.filter((item) => item.event.text !== null),
          Stream.runHead,
        );

        const [inFlight] = yield* ledger.listRuns(10);
        assert.strictEqual(inFlight?.status, "running");
        assert.strictEqual(inFlight?.session, "sess-42");
        assert.isNull(inFlight?.endedAtMillis);

        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(running);

        const [finished] = yield* ledger.listRuns(10);
        assert.strictEqual(finished?.status, "succeeded");
        assert.strictEqual(finished?.session, "sess-42");
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect("holds the claim when the run is interrupted so recovery can resume it", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
      const release = yield* Deferred.make<void>();
      const layer = provide(recorder(calls), [gatedRunner(release)]);
      yield* Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        const bus = yield* RunEventBus.RunEventBus;
        const subscription = yield* bus.subscribe();
        const running = yield* Effect.forkChild(executor.execute(implementWorkspace, implementItem));

        yield* Stream.fromSubscription(subscription).pipe(
          Stream.filter((item) => item.event.text !== null),
          Stream.runHead,
        );
        yield* Fiber.interrupt(running);

        const log = yield* Ref.get(calls);
        assert.isTrue(log.some((c) => c.method === "claim"));
        assert.isFalse(log.some((c) => c.method === "release"));
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect("ledgers the newest session when the harness starts a fresh one mid-run", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
      const restarted: ReadonlyArray<HarnessEvent> = [
        ...implementStreamEvents,
        {
          type: "CUSTOM",
          name: "session",
          text: null,
          sessionId: "sess-99",
          usage: null,
          finishReason: null,
        },
        implementFinished,
      ];
      const layer = provide(recorder(calls), [runner(restarted)]);
      yield* Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        yield* executor.execute(implementWorkspace, implementItem);

        const ledger = yield* RunLedger.RunLedger;
        const [run] = yield* ledger.listRuns(10);
        assert.strictEqual(run?.session, "sess-99");
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("resumes the branch's persisted session on a later implement run", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
      const requests = yield* Ref.make<ReadonlyArray<HarnessRequest>>([]);
      const layer = provide(recorder(calls), [capturingRunner(requests, implementEvents)]);
      yield* Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        yield* executor.execute(implementWorkspace, implementItem);
        yield* executor.execute(implementWorkspace, implementItem);

        const captured = yield* Ref.get(requests);
        assert.strictEqual(captured.length, 2);
        assert.isNull(captured[0]?.sessionId ?? null);
        assert.strictEqual(captured[1]?.sessionId, "sess-42");
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("resumes an interrupted run with a continuation nudge and its persisted session", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
      const requests = yield* Ref.make<ReadonlyArray<HarnessRequest>>([]);
      const ensured = yield* Ref.make<ReadonlyArray<boolean>>([]);
      const resumeItem = {
        ...implementItem,
        resume: { session: previousSession, reason: "interrupted" as const },
      };
      const layer = provide(
        recorder(calls),
        [capturingRunner(requests, implementEvents)],
        resumeRecordingWorktree(ensured),
      );
      yield* Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        yield* executor.execute(implementWorkspace, resumeItem);

        const [request] = yield* Ref.get(requests);
        assert.strictEqual(request?.checkoutPath, `/wt/${implementBranch}`);
        assert.strictEqual(request?.sessionId, "sess-prev");
        assert.include(request?.prompt ?? "", "You were interrupted part-way through");
        assert.include(request?.prompt ?? "", `Inspect /wt/${implementBranch}`);
        assert.notInclude(request?.prompt ?? "", "implement-agent");
        assert.notInclude(request?.prompt ?? "", "IMPLEMENT-RESULT");

        assert.deepStrictEqual(yield* Ref.get(ensured), [true]);

        const log = yield* Ref.get(calls);
        assert.strictEqual(log.find((c) => c.method === "recordAttempt")?.outcome, "succeeded");
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("keeps the session of a run the harness failed mid-stream so the retry resumes it", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
      const requests = yield* Ref.make<ReadonlyArray<HarnessRequest>>([]);
      const error = new HarnessError({ reason: "turn", retryable: true, message: "network blip" });
      const layer = provide(recorder(calls), [
        capturingRunner(requests, implementStreamEvents, Stream.fail(error)),
      ]);
      yield* Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        yield* executor.execute(implementWorkspace, implementItem);

        const ledger = yield* RunLedger.RunLedger;
        const [run] = yield* ledger.listRuns(10);
        assert.strictEqual(run?.status, "failed");
        assert.strictEqual(run?.session, "sess-42");

        yield* executor.execute(implementWorkspace, implementItem);
        const captured = yield* Ref.get(requests);
        assert.strictEqual(captured[1]?.sessionId, "sess-42");
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("exhausts a failed implement job and hands the issue back to a human", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
      const error = new HarnessError({ reason: "launch", retryable: false, message: "no cli" });
      const layer = provide(recorder(calls), [failingRunner(error)]);
      yield* Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        yield* executor.execute(implementWorkspace, implementItem);

        const log = yield* Ref.get(calls);
        assert.strictEqual(log.find((c) => c.method === "recordAttempt")?.outcome, "failed");
        const roles = log.find((c) => c.method === "setRoles");
        assert.deepStrictEqual(roles?.remove, ["ready-for-agent"]);
        assert.deepStrictEqual(roles?.add, ["ready-for-human"]);
        assert.include(log.find((c) => c.method === "note")?.body ?? "", "no cli");

        const ledger = yield* RunLedger.RunLedger;
        const [run] = yield* ledger.listRuns(10);
        assert.strictEqual(run?.stage, "implement");
        assert.strictEqual(run?.status, "exhausted");
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("hands a diverged worktree to a human on the first attempt without retrying", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
      const requests = yield* Ref.make<ReadonlyArray<HarnessRequest>>([]);
      const layer = provide(recorder(calls), [capturingRunner(requests, implementEvents)], divergedWorktree);
      yield* Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        yield* executor.execute(implementWorkspace, implementItem);

        assert.strictEqual((yield* Ref.get(requests)).length, 0);
        const log = yield* Ref.get(calls);
        assert.strictEqual(log.find((c) => c.method === "recordAttempt")?.outcome, "failed");
        assert.include(log.find((c) => c.method === "recordAttempt")?.reason ?? "", "diverged");
        const roles = log.find((c) => c.method === "setRoles");
        assert.deepStrictEqual(roles?.remove, ["ready-for-agent"]);
        assert.deepStrictEqual(roles?.add, ["ready-for-human"]);
        const note = log.find((c) => c.method === "note")?.body ?? "";
        assert.include(note, "non-retryable failure");
        assert.include(note, "diverged");

        const ledger = yield* RunLedger.RunLedger;
        const [run] = yield* ledger.listRuns(10);
        assert.strictEqual(run?.status, "exhausted");
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("keeps retrying a prepare failure that is not a divergence", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
      const layer = provide(recorder(calls), [runner(implementEvents)], unreachableRemoteWorktree);
      yield* Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        yield* executor.execute(implementWorkspace, implementItem);

        const log = yield* Ref.get(calls);
        assert.strictEqual(log.find((c) => c.method === "recordAttempt")?.outcome, "failed");
        assert.isFalse(log.some((c) => c.method === "setRoles"));
        assert.isFalse(log.some((c) => c.method === "note"));

        const ledger = yield* RunLedger.RunLedger;
        const [run] = yield* ledger.listRuns(10);
        assert.strictEqual(run?.status, "failed");
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("hands a self-reported stuck implement run to a human without retrying", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
      const layer = provide(recorder(calls), [runner(stuckImplementEvents)]);
      yield* Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        yield* executor.execute(implementWorkspace, implementItem);

        const log = yield* Ref.get(calls);
        assert.strictEqual(log.find((c) => c.method === "recordAttempt")?.outcome, "failed");
        assert.include(
          log.find((c) => c.method === "recordAttempt")?.reason ?? "",
          "brief contradicts itself",
        );
        const roles = log.find((c) => c.method === "setRoles");
        assert.deepStrictEqual(roles?.remove, ["ready-for-agent"]);
        assert.deepStrictEqual(roles?.add, ["ready-for-human"]);
        assert.include(log.find((c) => c.method === "note")?.body ?? "", "brief contradicts itself");

        const ledger = yield* RunLedger.RunLedger;
        const [run] = yield* ledger.listRuns(10);
        assert.strictEqual(run?.status, "exhausted");
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("runs a follow-up job, records the follow-up marker, and never hands off on success", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
      const requests = yield* Ref.make<ReadonlyArray<HarnessRequest>>([]);
      const layer = provide(
        recorder(calls),
        [capturingRunner(requests, followUpEvents)],
        worktreeStubCreated(false),
      );
      yield* Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        yield* executor.execute(followUpWorkspace, followUpItem);

        const [request] = yield* Ref.get(requests);
        assert.strictEqual(request?.checkoutPath, `/wt/${followUpBranch}`);
        assert.include(request?.prompt ?? "", "follow-up-agent");
        assert.include(request?.prompt ?? "", "FOLLOWUP-RESULT");

        const log = yield* Ref.get(calls);
        assert.strictEqual(log.find((c) => c.method === "recordAttempt")?.outcome, "succeeded");
        assert.isFalse(log.some((c) => c.method === "setRoles"));
        assert.strictEqual(log.find((c) => c.method === "recordFollowUp")?.checks, "failing");
        assert.isFalse(log.some((c) => c.method === "note"));
        assert.isTrue(log.some((c) => c.method === "release"));

        const ledger = yield* RunLedger.RunLedger;
        const [run] = yield* ledger.listRuns(10);
        assert.strictEqual(run?.stage, "follow-up");
        assert.strictEqual(run?.branch, followUpBranch);
        assert.strictEqual(run?.status, "succeeded");
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("resumes the branch session on a later follow-up when the worktree was not recreated", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
      const requests = yield* Ref.make<ReadonlyArray<HarnessRequest>>([]);
      const layer = provide(
        recorder(calls),
        [capturingRunner(requests, followUpEvents)],
        worktreeStubCreated(false),
      );
      yield* Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        yield* executor.execute(followUpWorkspace, followUpItem);
        yield* executor.execute(followUpWorkspace, followUpItem);

        const captured = yield* Ref.get(requests);
        assert.isNull(captured[0]?.sessionId ?? null);
        assert.strictEqual(captured[1]?.sessionId, "sess-42");
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("starts a fresh follow-up session when the worktree was recreated", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
      const requests = yield* Ref.make<ReadonlyArray<HarnessRequest>>([]);
      const layer = provide(
        recorder(calls),
        [capturingRunner(requests, followUpEvents)],
        worktreeStubCreated(true),
      );
      yield* Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        yield* executor.execute(followUpWorkspace, followUpItem);
        yield* executor.execute(followUpWorkspace, followUpItem);

        const captured = yield* Ref.get(requests);
        assert.isNull(captured[1]?.sessionId ?? null);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("hands a stalled follow-up to a human with no harness run", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
      const requests = yield* Ref.make<ReadonlyArray<HarnessRequest>>([]);
      const layer = provide(recorder(calls), [capturingRunner(requests, followUpEvents)]);
      const stalledItem = {
        ...followUpItem,
        followUp: { ...followUpItem.followUp, noProgress: 3, stalled: true },
      };
      yield* Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        yield* executor.execute(followUpWorkspace, stalledItem);

        assert.strictEqual((yield* Ref.get(requests)).length, 0);
        const log = yield* Ref.get(calls);
        assert.deepStrictEqual(log.find((c) => c.method === "setRoles")?.add, ["ready-for-human"]);
        assert.strictEqual(log.find((c) => c.method === "recordAttempt")?.outcome, "abandoned");
        const handoff = log.find((c) => c.method === "recordFollowUp");
        assert.include(handoff?.body ?? "", "no progress");
        assert.strictEqual(handoff?.checks, "failing");
        assert.isFalse(log.some((c) => c.method === "note"));
        assert.isFalse(log.some((c) => c.method === "merge" || c.method === "resolve"));

        const ledger = yield* RunLedger.RunLedger;
        assert.strictEqual((yield* ledger.listRuns(10)).length, 0);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("retries a sentinel-less implement run and resumes its session on the next attempt", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
      const requests = yield* Ref.make<ReadonlyArray<HarnessRequest>>([]);
      const layer = provide(recorder(calls), [capturingRunner(requests, noSentinelImplementEvents)]);
      yield* Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        yield* executor.execute(implementWorkspace, implementItem);

        const log = yield* Ref.get(calls);
        assert.strictEqual(log.find((c) => c.method === "recordAttempt")?.outcome, "failed");
        assert.include(
          log.find((c) => c.method === "recordAttempt")?.reason ?? "",
          "agent produced no result line",
        );
        assert.isFalse(log.some((c) => c.method === "setRoles"));
        assert.isFalse(log.some((c) => c.method === "note"));

        const ledger = yield* RunLedger.RunLedger;
        const [firstRun] = yield* ledger.listRuns(10);
        assert.strictEqual(firstRun?.status, "failed");
        assert.strictEqual(firstRun?.session, "sess-42");

        yield* executor.execute(implementWorkspace, implementItem);
        const captured = yield* Ref.get(requests);
        assert.strictEqual(captured[1]?.sessionId, "sess-42");
      }).pipe(Effect.provide(layer));
    }),
  );
});
