import { HarnessName, type TokenUsage, WorkItemId, WorkspaceConfig } from "@clanker-forge/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Executor from "./Executor";
import {
  HarnessError,
  type HarnessEvent,
  type HarnessRequest,
  type HarnessRunner,
  layer as harnessLayer,
} from "./Harness";
import type { RegisteredWorkspace } from "./projector";
import * as RunEventBus from "./RunEventBus";
import * as RunLedger from "./RunLedger";
import { WorkSource, type WorkSourceService } from "./WorkSource";
import { branchName, WorktreeManager, type WorktreeManagerService } from "./Worktree";

const cursor = Schema.decodeSync(HarnessName)("cursor");
const id = Schema.decodeSync(WorkItemId);

const workspace: RegisteredWorkspace = {
  source: "gh.workspace.ts",
  config: Schema.decodeSync(WorkspaceConfig)({
    name: "gh",
    checkoutPath: "/repos/gh",
    workSource: { type: "github", repo: "owner/repo", botLogin: "clanker-bot" },
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
    workSource: { type: "github", repo: "owner/repo", botLogin: "clanker-bot" },
    harness: { preferred: "cursor" },
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

const implementEvents: ReadonlyArray<HarnessEvent> = [
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
  { type: "RUN_FINISHED", name: null, text: null, sessionId: null, usage, finishReason: "stop" },
];

const blockedImplementEvents: ReadonlyArray<HarnessEvent> = [
  { type: "RUN_STARTED", name: null, text: null, sessionId: null, usage: null, finishReason: null },
  {
    type: "TEXT_MESSAGE_CONTENT",
    name: null,
    text: "The brief contradicts itself; leaving for a human.\nIMPLEMENT-RESULT: blocked",
    sessionId: null,
    usage: null,
    finishReason: null,
  },
  { type: "RUN_FINISHED", name: null, text: null, sessionId: null, usage, finishReason: "stop" },
];

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
    workSource: { type: "github", repo: "owner/repo", botLogin: "clanker-bot" },
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
    blocked: false,
    fresh: false,
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
    workSource: { type: "github", repo: "owner/repo" },
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
}

const record = (calls: Ref.Ref<ReadonlyArray<Call>>, entry: Call) =>
  Ref.update(calls, (xs) => [...xs, entry]);

const recorder = (calls: Ref.Ref<ReadonlyArray<Call>>): WorkSourceService => ({
  observe: () => Effect.succeed([]),
  claim: (_workspace, itemId) => record(calls, { method: "claim", item: itemId }),
  release: (_workspace, itemId) => record(calls, { method: "release", item: itemId }),
  recordAttempt: (_workspace, itemId, attempt) =>
    record(calls, { method: "recordAttempt", item: itemId, outcome: attempt.outcome }),
  comment: (_workspace, itemId, body) => record(calls, { method: "comment", item: itemId, body }),
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
): HarnessRunner => ({
  name: cursor,
  run: (request) =>
    Stream.unwrap(
      Ref.update(requests, (xs) => [...xs, request]).pipe(Effect.map(() => Stream.fromArray(events))),
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
  ws: WorkSourceService,
  runners: ReadonlyArray<HarnessRunner>,
  worktree: WorktreeManagerService = worktreeStub,
) =>
  Executor.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(WorkSource, ws),
        harnessLayer(runners),
        RunLedger.layerMemory,
        RunEventBus.layer,
        Layer.succeed(WorktreeManager, worktree),
      ),
    ),
  );

describe("Executor.execute", () => {
  it.effect("triages an eligible item into a proposal comment, label advance, and ledgered run", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
      const layer = provide(recorder(calls), [runner(successEvents)]);
      yield* Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        yield* executor.execute(workspace, triageItem);

        const log = yield* Ref.get(calls);
        const comment = log.find((c) => c.method === "comment");
        assert.isDefined(comment);
        assert.include(comment?.body ?? "", "genuine bug in the exporter");
        assert.notInclude(comment?.body ?? "", "TRIAGE-DECISION");
        assert.include(comment?.body ?? "", "generated by AI");

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
        assert.isTrue(log.some((c) => c.method === "comment"));
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("marks a non-retryable harness failure as blocked and hands it to a human", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
      const error = new HarnessError({ reason: "launch", retryable: false, message: "no cli" });
      const layer = provide(recorder(calls), [failingRunner(error)]);
      yield* Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        yield* executor.execute(workspace, triageItem);

        const log = yield* Ref.get(calls);
        assert.strictEqual(log.find((c) => c.method === "recordAttempt")?.outcome, "failed");
        assert.deepStrictEqual(log.find((c) => c.method === "setRoles")?.add, ["ready-for-human"]);
        assert.isFalse(log.some((c) => c.method === "comment"));

        const ledger = yield* RunLedger.RunLedger;
        const runs = yield* ledger.listRuns(10);
        assert.strictEqual(runs[0]?.status, "blocked");
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("records a retryable failure as an attempt without a blocked marker", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
      const error = new HarnessError({ reason: "turn", retryable: true, message: "network blip" });
      const layer = provide(recorder(calls), [failingRunner(error)]);
      yield* Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        yield* executor.execute(workspace, triageItem);

        const log = yield* Ref.get(calls);
        assert.strictEqual(log.find((c) => c.method === "recordAttempt")?.outcome, "failed");
        assert.isFalse(log.some((c) => c.method === "setRoles"));

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

  it.effect("blocks a retryable failure once its attempt reaches the cap", () =>
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

        const ledger = yield* RunLedger.RunLedger;
        const runs = yield* ledger.listRuns(10);
        assert.strictEqual(runs[0]?.status, "blocked");
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

        const log = yield* Ref.get(calls);
        assert.strictEqual(log.find((c) => c.method === "recordAttempt")?.outcome, "succeeded");
        assert.isTrue(log.some((c) => c.method === "release"));
        assert.isFalse(log.some((c) => c.method === "comment"));
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

  it.effect("blocks a failed implement job and hands the issue back to a human", () =>
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
        assert.isFalse(log.some((c) => c.method === "comment"));

        const ledger = yield* RunLedger.RunLedger;
        const [run] = yield* ledger.listRuns(10);
        assert.strictEqual(run?.stage, "implement");
        assert.strictEqual(run?.status, "blocked");
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("hands a self-reported blocked implement run to a human without retrying", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
      const layer = provide(recorder(calls), [runner(blockedImplementEvents)]);
      yield* Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        yield* executor.execute(implementWorkspace, implementItem);

        const log = yield* Ref.get(calls);
        assert.strictEqual(log.find((c) => c.method === "recordAttempt")?.outcome, "failed");
        const roles = log.find((c) => c.method === "setRoles");
        assert.deepStrictEqual(roles?.remove, ["ready-for-agent"]);
        assert.deepStrictEqual(roles?.add, ["ready-for-human"]);

        const ledger = yield* RunLedger.RunLedger;
        const [run] = yield* ledger.listRuns(10);
        assert.strictEqual(run?.status, "blocked");
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
        const marker = log.find((c) => c.method === "comment");
        assert.include(marker?.body ?? "", "clanker-forge:follow-up");
        assert.include(marker?.body ?? "", "checks=failing");
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

  it.effect("blocks a no-progress follow-up with a human handoff and no harness run", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
      const requests = yield* Ref.make<ReadonlyArray<HarnessRequest>>([]);
      const layer = provide(recorder(calls), [capturingRunner(requests, followUpEvents)]);
      const blockedItem = {
        ...followUpItem,
        followUp: { ...followUpItem.followUp, noProgress: 3, blocked: true },
      };
      yield* Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        yield* executor.execute(followUpWorkspace, blockedItem);

        assert.strictEqual((yield* Ref.get(requests)).length, 0);
        const log = yield* Ref.get(calls);
        assert.deepStrictEqual(log.find((c) => c.method === "setRoles")?.add, ["ready-for-human"]);
        assert.strictEqual(log.find((c) => c.method === "recordAttempt")?.outcome, "abandoned");
        assert.include(log.find((c) => c.method === "comment")?.body ?? "", "no progress");
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
        assert.isFalse(log.some((c) => c.method === "setRoles"));

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
