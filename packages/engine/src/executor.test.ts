import {
  HarnessName,
  type SessionId,
  SessionId as SessionIdSchema,
  type SessionKind,
  sessionHandle,
  type TokenUsage,
  WorkItemId,
  WorkspaceConfig,
} from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { EligibleWork } from "./classify";
import * as ContextAssembler from "./context-assembler";
import * as CredentialStore from "./credential-store";
import * as DaemonEventBus from "./daemon-event-bus";
import * as Executor from "./executor";
import { GitError } from "./git";
import {
  type AgUiEvent,
  HarnessError,
  type HarnessRequest,
  type HarnessRunner,
  layer as harnessLayer,
} from "./harness";
import { IssueTracker, IssueTrackerError, type IssueTrackerService } from "./issue-tracker";
import { McpSkillAssembler } from "./mcp-skill";
import type { RegisteredWorkspace } from "./projector";
import * as RunControl from "./run-control";
import * as RunLedger from "./run-ledger";
import { layer as runRecorderLayer } from "./run-recorder";
import * as SessionStore from "./session-store";
import { SourceControlProvider, type SourceControlProviderService } from "./source-control";
import { branchName, WorktreeDivergedError, WorktreeManager, type WorktreeManagerService } from "./worktree";

const cursor = Schema.decodeSync(HarnessName)("cursor");
const codex = Schema.decodeSync(HarnessName)("codex");
const id = Schema.decodeSync(WorkItemId);
const previousSession = Schema.decodeSync(SessionIdSchema)("sess-prev");

const handleOf = (ledger: RunLedger.RunLedgerService, session: SessionId | null | undefined) =>
  session ? Effect.map(ledger.getSession(session), sessionHandle) : Effect.succeed(null);

const kindOf = (ledger: RunLedger.RunLedgerService, session: SessionId | null | undefined) =>
  session ? Effect.map(ledger.getSession(session), (found) => found?.kind ?? null) : Effect.succeed(null);

const seedResumeSession = (handle: string | null = "sess-prev") =>
  Effect.flatMap(RunLedger.RunLedger, (ledger) =>
    ledger.insertSession({
      kind: "opaque-handle",
      id: previousSession,
      workspace: workspace.config.name,
      harness: cursor,
      createdAtMillis: 0,
      handle,
    }),
  );

const workspace: RegisteredWorkspace = {
  source: "gh.workspace.ts",
  config: Schema.decodeSync(WorkspaceConfig)({
    name: "gh",
    checkoutPath: "/repos/gh",
    issueTracker: { type: "github", repo: "owner/repo", actorLogin: "cogwork-bot" },
    harness: { preferred: "cursor" },
    playbook: { triage: { enabled: true } },
  }),
};

const triageItem = {
  id: id("#7"),
  title: "broken export",
  stage: "triage" as const,
  priority: "medium" as const,
  priorFailures: 0,
};

const usage: TokenUsage = { inputTokens: 12, outputTokens: 34, totalTokens: 46 };

const text = (delta: string) => ({ type: "TEXT_MESSAGE_CONTENT", delta }) satisfies AgUiEvent;

const sessionEvent = (sessionId: string) =>
  ({
    type: "CUSTOM",
    name: "cursor.session-id",
    value: { sessionId },
  }) satisfies AgUiEvent;

const structuredComplete = (object: unknown, raw: string) =>
  ({
    type: "CUSTOM",
    name: "structured-output.complete",
    value: { object, raw },
  }) satisfies AgUiEvent;

const runStarted: AgUiEvent = { type: "RUN_STARTED" };

const finished: AgUiEvent = {
  type: "RUN_FINISHED",
  finishReason: "stop",
  usage: { promptTokens: 12, completionTokens: 34, totalTokens: 46 },
};

const implementWorkspace: RegisteredWorkspace = {
  source: workspace.source,
  config: Schema.decodeSync(WorkspaceConfig)({
    name: "gh",
    checkoutPath: "/repos/gh",
    issueTracker: { type: "github", repo: "owner/repo", actorLogin: "cogwork-bot" },
    harness: { preferred: "cursor" },
    playbook: { implement: { enabled: true } },
  }),
};

const codexImplementWorkspace: RegisteredWorkspace = {
  ...implementWorkspace,
  config: Schema.decodeSync(WorkspaceConfig)({
    ...implementWorkspace.config,
    playbook: { implement: { enabled: true, harness: "codex" } },
  }),
};

const mcpWorkspace: RegisteredWorkspace = {
  source: workspace.source,
  config: Schema.decodeSync(WorkspaceConfig)({
    name: "gh",
    checkoutPath: "/repos/gh",
    issueTracker: { type: "github", repo: "owner/repo", actorLogin: "cogwork-bot" },
    harness: { preferred: "cursor" },
    mcpSkills: [{ name: "linear", endpoint: "https://mcp.linear.app/mcp/readonly" }],
    playbook: { implement: { enabled: true } },
  }),
};

const mcpAuthWorkspace: RegisteredWorkspace = {
  source: workspace.source,
  config: Schema.decodeSync(WorkspaceConfig)({
    name: "gh",
    checkoutPath: "/repos/gh",
    issueTracker: { type: "github", repo: "owner/repo", actorLogin: "cogwork-bot" },
    harness: { preferred: "cursor" },
    mcpSkills: [
      { name: "linear", endpoint: "https://mcp.linear.app/mcp/readonly", auth: { type: "credential-store" } },
    ],
    playbook: { implement: { enabled: true } },
  }),
};

// A stand-in for the real credential-store-backed assembler: it hands back a redacted bearer for any
// skill that declares auth, so the executor tests can prove the token reaches the request without
// wiring a live credential store.
const contextAssemblerStub = Layer.succeed(ContextAssembler.ContextAssembler, {
  assemble: () => Effect.succeed({ layers: [], skillPath: "/" }),
});

const assemblerStub = Layer.succeed(McpSkillAssembler, {
  assemble: (config) =>
    Effect.succeed(
      (config.mcpSkills ?? []).map((skill) => ({
        name: skill.name,
        endpoint: skill.endpoint,
        bearer: skill.auth ? Redacted.make(`token-for-${skill.name}`) : null,
      })),
    ),
});

const implementItem = {
  id: id("#15"),
  title: "Implement playbook",
  stage: "implement" as const,
  priority: "medium" as const,
  priorFailures: 0,
};

const implementBranch = branchName(implementItem);

const implementStreamEvents: ReadonlyArray<AgUiEvent> = [
  runStarted,
  sessionEvent("sess-42"),
  text("Opened PR #99, Closes #15."),
  structuredComplete(
    { _tag: "implement", outcome: "opened-pr", summary: "Opened PR #99, Closes #15." },
    '{"_tag":"implement","outcome":"opened-pr","summary":"Opened PR #99, Closes #15."}',
  ),
];

const implementFinished: AgUiEvent = finished;

const implementEvents: ReadonlyArray<AgUiEvent> = [...implementStreamEvents, implementFinished];

const resumedImplementEvents: ReadonlyArray<AgUiEvent> = [
  runStarted,
  sessionEvent("sess-prev"),
  text("Picked up where I left off."),
  structuredComplete(
    { _tag: "implement", outcome: "opened-pr", summary: "Opened PR #99." },
    '{"_tag":"implement","outcome":"opened-pr","summary":"Opened PR #99."}',
  ),
  implementFinished,
];

const stuckImplementEvents: ReadonlyArray<AgUiEvent> = [
  runStarted,
  text("The brief contradicts itself; leaving for a human."),
  structuredComplete(
    { _tag: "implement", outcome: "stuck", summary: "The brief contradicts itself." },
    '{"_tag":"implement","outcome":"stuck","summary":"The brief contradicts itself."}',
  ),
  finished,
];

const gatedRunner = (release: Deferred.Deferred<void>): HarnessRunner => ({
  name: cursor,
  sessionKind: "opaque-handle",
  run: () =>
    Stream.concat(
      Stream.fromArray(implementStreamEvents),
      Stream.unwrap(Deferred.await(release).pipe(Effect.map(() => Stream.fromArray([implementFinished])))),
    ),
});

const missingImplementResultEvents: ReadonlyArray<AgUiEvent> = [
  runStarted,
  sessionEvent("sess-42"),
  text("Made progress but ran out of turn before opening a PR."),
  finished,
];

const malformedImplementResultEvents: ReadonlyArray<AgUiEvent> = [
  runStarted,
  structuredComplete(
    { _tag: "implement", outcome: "opened-pr", summary: " " },
    '{"_tag":"implement","outcome":"opened-pr","summary":" "}',
  ),
  finished,
];

const followUpWorkspace: RegisteredWorkspace = {
  source: workspace.source,
  config: Schema.decodeSync(WorkspaceConfig)({
    name: "gh",
    checkoutPath: "/repos/gh",
    issueTracker: { type: "github", repo: "owner/repo", actorLogin: "cogwork-bot" },
    harness: { preferred: "cursor" },
    playbook: { "follow-up": { enabled: true } },
  }),
};

const followUpItem = {
  id: id("#5"),
  title: "PR follow-up playbook",
  stage: "follow-up" as const,
  priority: "medium" as const,
  priorFailures: 0,
  followUp: {
    checks: "failing" as const,
    humanCommentAtMillis: 0,
    botTriggerAtMillis: 0,
    noProgress: 0,
    stalled: false,
    fresh: false,
    baseDivergence: "none" as const,
  },
};

const followUpBranch = branchName(followUpItem);

const followUpEvents: ReadonlyArray<AgUiEvent> = [
  runStarted,
  sessionEvent("sess-42"),
  text("Fixed the failing check and pushed."),
  structuredComplete(
    { _tag: "follow-up", outcome: "pushed", summary: "Fixed the failing check and pushed." },
    '{"_tag":"follow-up","outcome":"pushed","summary":"Fixed the failing check and pushed."}',
  ),
  finished,
];

const noopFollowUpEvents: ReadonlyArray<AgUiEvent> = [
  runStarted,
  sessionEvent("sess-42"),
  text("The PR is green and the comment needed no code change."),
  structuredComplete(
    { _tag: "follow-up", outcome: "noop", summary: "The PR is green and needs no code change." },
    '{"_tag":"follow-up","outcome":"noop","summary":"The PR is green and needs no code change."}',
  ),
  finished,
];

const stuckFollowUpEvents: ReadonlyArray<AgUiEvent> = [
  runStarted,
  text("The review feedback contradicts the checks; leaving for a human."),
  structuredComplete(
    {
      _tag: "follow-up",
      outcome: "stuck",
      summary: "The review feedback contradicts the checks; leaving for a human.",
    },
    '{"_tag":"follow-up","outcome":"stuck","summary":"The review feedback contradicts the checks; leaving for a human."}',
  ),
  finished,
];

const missingFollowUpResultEvents: ReadonlyArray<AgUiEvent> = [
  runStarted,
  text("Made progress but ran out of turn."),
  finished,
];

const malformedFollowUpResultEvents: ReadonlyArray<AgUiEvent> = [
  runStarted,
  structuredComplete(
    { _tag: "follow-up", outcome: "pushed", summary: " " },
    '{"_tag":"follow-up","outcome":"pushed","summary":" "}',
  ),
  finished,
];

// An owned-transcript run never hands back a session handle — its conversation
// lives in the run ledger — so these events carry no session id.
const ownedFollowUpEvents: ReadonlyArray<AgUiEvent> = [
  runStarted,
  text("Fixed the failing check and pushed."),
  structuredComplete(
    { _tag: "follow-up", outcome: "pushed", summary: "Fixed the failing check and pushed." },
    '{"_tag":"follow-up","outcome":"pushed","summary":"Fixed the failing check and pushed."}',
  ),
  finished,
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
  readonly role?: string;
  readonly proposal?: string;
  readonly stage?: string;
  readonly reason?: string;
  readonly note?: string;
  readonly checks?: string;
  readonly detail?: string;
}

const record = (calls: Ref.Ref<ReadonlyArray<Call>>, entry: Call) =>
  Ref.update(calls, (xs) => [...xs, entry]);

const recorder = (calls: Ref.Ref<ReadonlyArray<Call>>): IssueTrackerService => ({
  rateLimitScope: () => null,
  observe: () => Effect.succeed([]),
  claim: (_workspace, itemId) => record(calls, { method: "claim", item: itemId }),
  release: (_workspace, itemId) => record(calls, { method: "release", item: itemId }),
  note: () => Effect.void,
  triaged: (_workspace, itemId, outcome) =>
    record(calls, { method: "triaged", item: itemId, role: outcome.role, proposal: outcome.proposal }),
  implemented: (_workspace, itemId) => record(calls, { method: "implemented", item: itemId }),
  followedUp: (_workspace, itemId, outcome) =>
    record(calls, { method: "followedUp", item: itemId, checks: outcome.marker.checks }),
  attemptFailed: (_workspace, itemId, outcome) =>
    record(calls, { method: "attemptFailed", item: itemId, stage: outcome.stage, reason: outcome.reason }),
  handOff: (_workspace, itemId, outcome) =>
    record(calls, { method: "handOff", item: itemId, stage: outcome.stage, note: outcome.note }),
  stalled: (_workspace, itemId, outcome) =>
    record(calls, { method: "stalled", item: itemId, checks: outcome.marker.checks, detail: outcome.detail }),
  reclassify: () => Effect.void,
});

const runner = (events: ReadonlyArray<AgUiEvent>): HarnessRunner => ({
  name: cursor,
  sessionKind: "opaque-handle",
  run: () => Stream.fromArray(events),
});

const capturingRunner = (
  requests: Ref.Ref<ReadonlyArray<HarnessRequest>>,
  events: ReadonlyArray<AgUiEvent>,
  tail: Stream.Stream<AgUiEvent, HarnessError> = Stream.empty,
  sessionKind: SessionKind = "opaque-handle",
  name: HarnessName = cursor,
): HarnessRunner => ({
  name,
  sessionKind,
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
  sessionKind: "opaque-handle",
  run: () => Stream.fail(error),
});

const ownedTranscriptRunner = (events: ReadonlyArray<AgUiEvent>): HarnessRunner => ({
  name: cursor,
  sessionKind: "owned-transcript",
  run: () => Stream.fromArray(events),
});

const successEvents: ReadonlyArray<AgUiEvent> = [
  runStarted,
  sessionEvent("sess-42"),
  text("Investigated the exporter and verified the failure."),
  finished,
  structuredComplete(
    {
      _tag: "triage",
      role: "ready-for-agent",
      proposal: "This is a genuine bug in the exporter.",
    },
    '{"_tag":"triage","role":"ready-for-agent","proposal":"This is a genuine bug in the exporter."}',
  ),
];

interface PostedComment {
  readonly item: string;
  readonly body: string;
}

const noopProvider: SourceControlProviderService = {
  observe: () => Effect.succeed(new Map()),
  comment: () => Effect.void,
};

const recordingProvider = (posted: Ref.Ref<ReadonlyArray<PostedComment>>): SourceControlProviderService => ({
  observe: () => Effect.succeed(new Map()),
  comment: (_workspace, item, body) => Ref.update(posted, (xs) => [...xs, { item: item.id, body }]),
});

const unavailableCommentProvider: SourceControlProviderService = {
  observe: () => Effect.succeed(new Map()),
  comment: () =>
    Effect.fail(
      new IssueTrackerError({ reason: "unavailable", message: "GitHub comment endpoint unavailable" }),
    ),
};

const provide = (
  ws: IssueTrackerService,
  runners: ReadonlyArray<HarnessRunner>,
  worktree: WorktreeManagerService = worktreeStub,
  sourceControl: SourceControlProviderService = noopProvider,
) => {
  const bus = DaemonEventBus.layer;
  const runLedger = RunLedger.layerMemory.pipe(Layer.provide(bus));
  const runRecorder = runRecorderLayer.pipe(Layer.provide(runLedger), Layer.provide(bus));
  const sessionStore = SessionStore.layer.pipe(Layer.provide(runLedger), Layer.provide(runRecorder));
  const runnerServices = Layer.mergeAll(sessionStore, contextAssemblerStub, CredentialStore.layerEnv);
  return Executor.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(IssueTracker, ws),
        Layer.succeed(SourceControlProvider, sourceControl),
        sessionStore,
        harnessLayer(runners).pipe(Layer.provide(runnerServices)),
        runLedger,
        runRecorder,
        bus,
        RunControl.layer,
        Layer.succeed(WorktreeManager, worktree),
        assemblerStub,
      ),
    ),
  );
};

describe("Executor.execute", () => {
  it.effect("triages an eligible item into a proposal note, label advance, and ledgered run", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
      const layer = provide(recorder(calls), [runner(successEvents)]);
      yield* Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        yield* executor.execute(workspace, triageItem);

        const log = yield* Ref.get(calls);
        const triaged = log.find((c) => c.method === "triaged");
        assert.isDefined(triaged);
        assert.strictEqual(triaged?.role, "ready-for-agent");
        assert.include(triaged?.proposal ?? "", "genuine bug in the exporter");
        assert.include(triaged?.proposal ?? "", "generated by AI");
        assert.isTrue(log.some((c) => c.method === "release"));

        const ledger = yield* RunLedger.RunLedger;
        const runs = yield* ledger.listRuns(10);
        assert.strictEqual(runs.length, 1);
        const [firstRun] = runs;
        assert.isDefined(firstRun);
        assert.strictEqual(firstRun?.status, "succeeded");
        assert.strictEqual(yield* handleOf(ledger, firstRun?.session), "sess-42");
        assert.deepStrictEqual(firstRun?.usage, usage);
        assert.strictEqual(firstRun?.eventCount, successEvents.length);

        const events = firstRun ? yield* ledger.events(firstRun.id) : [];
        assert.strictEqual(events.length, successEvents.length);
        assert.deepStrictEqual(
          events.map((e) => e.seq),
          successEvents.map((_, i) => i),
        );
        assert.strictEqual(events.at(-2)?.name, "structured-output.complete");
        assert.strictEqual(events.at(-1)?.type, "RUN_FINISHED");
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("retries a triage run that emits no structured result", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
      const layer = provide(recorder(calls), [runner([text("I could not produce a result."), finished])]);
      yield* Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        yield* executor.execute(workspace, triageItem);
        const log = yield* Ref.get(calls);
        assert.isFalse(log.some((call) => call.method === "triaged"));
        assert.include(log.find((call) => call.method === "attemptFailed")?.reason ?? "", "structured");
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("retries a triage run that emits more than one structured result", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
      const result = {
        _tag: "triage",
        role: "ready-for-agent",
        proposal: "Verified and ready.",
      };
      const raw = '{"_tag":"triage","role":"ready-for-agent","proposal":"Verified and ready."}';
      const duplicate: ReadonlyArray<AgUiEvent> = [
        structuredComplete(result, raw),
        structuredComplete(result, raw),
        finished,
      ];
      const layer = provide(recorder(calls), [runner(duplicate)]);
      yield* Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        yield* executor.execute(workspace, triageItem);
        const log = yield* Ref.get(calls);
        assert.isFalse(log.some((call) => call.method === "triaged"));
        assert.include(log.find((call) => call.method === "attemptFailed")?.reason ?? "", "received 2");
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("retries malformed Cursor output without coercing proposal prose into a role", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
      const malformed: ReadonlyArray<AgUiEvent> = [
        text("## Triage proposal\n\n**Disposition:** ready-for-agent"),
        structuredComplete(
          { _tag: "triage", role: "banana", proposal: "Looks ready from the prose." },
          '{"_tag":"triage","role":"banana","proposal":"Looks ready from the prose."}',
        ),
        finished,
      ];
      const layer = provide(recorder(calls), [runner(malformed)]);
      yield* Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        yield* executor.execute(workspace, triageItem);
        const log = yield* Ref.get(calls);
        assert.isFalse(log.some((call) => call.method === "triaged"));
        assert.include(log.find((call) => call.method === "attemptFailed")?.reason ?? "", "structured");
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("retries a structured completion envelope without raw output", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
      const malformed: ReadonlyArray<AgUiEvent> = [
        {
          type: "CUSTOM",
          name: "structured-output.complete",
          value: {
            object: {
              _tag: "triage",
              role: "ready-for-agent",
              proposal: "Verified and ready.",
            },
          },
        },
        finished,
      ];
      const layer = provide(recorder(calls), [runner(malformed)]);
      yield* Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        yield* executor.execute(workspace, triageItem);
        const log = yield* Ref.get(calls);
        assert.isFalse(log.some((call) => call.method === "triaged"));
        assert.include(log.find((call) => call.method === "attemptFailed")?.reason ?? "", "structured");

        const ledger = yield* RunLedger.RunLedger;
        const runs = yield* ledger.listRuns(10);
        const events = runs[0] ? yield* ledger.events(runs[0].id) : [];
        assert.include(events.at(-1)?.data ?? "", '"finishReason":"failed"');
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
        const attempt = log.find((c) => c.method === "attemptFailed");
        assert.strictEqual(attempt?.stage, "triage");
        assert.strictEqual(attempt?.reason, "no cli");
        const handOff = log.find((c) => c.method === "handOff");
        assert.isDefined(handOff);
        assert.include(handOff?.note ?? "", "non-retryable failure");
        assert.include(handOff?.note ?? "", "no cli");

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
        const attempt = log.find((c) => c.method === "attemptFailed");
        assert.strictEqual(attempt?.stage, "triage");
        assert.strictEqual(attempt?.reason, "network blip");
        assert.isFalse(log.some((c) => c.method === "handOff"));

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
        assert.strictEqual(log.find((c) => c.method === "attemptFailed")?.stage, "triage");
        const handOff = log.find((c) => c.method === "handOff");
        assert.isDefined(handOff);
        assert.include(handOff?.note ?? "", "3 failed triage attempts");

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
        assert.strictEqual(log.find((c) => c.method === "handOff")?.stage, "triage");
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
        assert.deepStrictEqual([...(request?.mcpSkills ?? [])], []);

        const log = yield* Ref.get(calls);
        assert.isTrue(log.some((c) => c.method === "implemented"));
        assert.isTrue(log.some((c) => c.method === "release"));
        assert.isFalse(log.some((c) => c.method === "handOff"));

        const ledger = yield* RunLedger.RunLedger;
        const [run] = yield* ledger.listRuns(10);
        assert.strictEqual(request?.session, run?.session);
        assert.strictEqual(run?.stage, "implement");
        assert.strictEqual(run?.branch, implementBranch);
        assert.strictEqual(run?.status, "succeeded");
        assert.strictEqual(yield* handleOf(ledger, run?.session), "sess-42");
        assert.deepStrictEqual(run?.usage, usage);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("mints an opaque-handle session for a Cursor-served run and captures its handle", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
      const layer = provide(recorder(calls), [runner(implementEvents)]);
      yield* Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        yield* executor.execute(implementWorkspace, implementItem);

        const ledger = yield* RunLedger.RunLedger;
        const [run] = yield* ledger.listRuns(10);
        assert.strictEqual(yield* kindOf(ledger, run?.session), "opaque-handle");
        assert.strictEqual(yield* handleOf(ledger, run?.session), "sess-42");
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("mints an owned-transcript session for a provider-served run", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
      const layer = provide(recorder(calls), [ownedTranscriptRunner(implementEvents)]);
      yield* Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        yield* executor.execute(implementWorkspace, implementItem);

        const ledger = yield* RunLedger.RunLedger;
        const [run] = yield* ledger.listRuns(10);
        assert.strictEqual(run?.status, "succeeded");
        assert.strictEqual(yield* kindOf(ledger, run?.session), "owned-transcript");
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
        assert.deepStrictEqual(
          [...(request?.mcpSkills ?? [])],
          [{ name: "linear", endpoint: "https://mcp.linear.app/mcp/readonly", bearer: null }],
        );
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("resolves a credential-store bearer for an authed skill without leaking it to the ledger", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
      const requests = yield* Ref.make<ReadonlyArray<HarnessRequest>>([]);
      const layer = provide(recorder(calls), [capturingRunner(requests, implementEvents)]);
      yield* Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        yield* executor.execute(mcpAuthWorkspace, implementItem);

        const [request] = yield* Ref.get(requests);
        const [skill] = request?.mcpSkills ?? [];
        assert.strictEqual(skill?.name, "linear");
        assert.isNotNull(skill?.bearer ?? null);
        assert.strictEqual(skill?.bearer ? Redacted.value(skill.bearer) : null, "token-for-linear");

        const ledger = yield* RunLedger.RunLedger;
        const [run] = yield* ledger.listRuns(10);
        const events = run ? yield* ledger.events(run.id) : [];
        assert.isFalse(events.some((event) => event.data.includes("token-for-linear")));
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
        const bus = yield* DaemonEventBus.DaemonEventBus;
        const subscription = yield* bus.subscribe();
        const running = yield* Effect.forkChild(executor.execute(implementWorkspace, implementItem));

        yield* DaemonEventBus.runActivityStream(Stream.fromSubscription(subscription)).pipe(
          Stream.filter((item) => item.event.type === "TEXT_MESSAGE_CONTENT"),
          Stream.runHead,
        );

        const [inFlight] = yield* ledger.listRuns(10);
        assert.strictEqual(inFlight?.status, "running");
        assert.strictEqual(yield* handleOf(ledger, inFlight?.session), "sess-42");
        assert.isNull(inFlight?.endedAtMillis);

        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(running);

        const [finished] = yield* ledger.listRuns(10);
        assert.strictEqual(finished?.status, "succeeded");
        assert.strictEqual(yield* handleOf(ledger, finished?.session), "sess-42");
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
        const bus = yield* DaemonEventBus.DaemonEventBus;
        const subscription = yield* bus.subscribe();
        const running = yield* Effect.forkChild(executor.execute(implementWorkspace, implementItem));

        yield* DaemonEventBus.runActivityStream(Stream.fromSubscription(subscription)).pipe(
          Stream.filter((item) => item.event.type === "TEXT_MESSAGE_CONTENT"),
          Stream.runHead,
        );
        yield* Fiber.interrupt(running);

        const log = yield* Ref.get(calls);
        assert.isTrue(log.some((c) => c.method === "claim"));
        assert.isFalse(log.some((c) => c.method === "release"));
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect("ledgers the branch session before an interrupted worktree prepare", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
      const prepares = yield* Ref.make(0);
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const worktree: WorktreeManagerService = {
        ...worktreeStubCreated(false),
        ensure: (_workspace, item) =>
          Ref.getAndUpdate(prepares, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === 0
                ? Effect.succeed({
                    branch: branchName(item),
                    path: `/wt/${branchName(item)}`,
                    created: false,
                  })
                : Deferred.succeed(entered, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.map(() => ({
                      branch: branchName(item),
                      path: `/wt/${branchName(item)}`,
                      created: false,
                    })),
                  ),
            ),
          ),
        list: () => Effect.succeed([]),
        remove: () => Effect.void,
        reconcile: () => Effect.succeed({ tornDown: [], reaped: [] }),
      };
      const layer = provide(recorder(calls), [runner(implementEvents)], worktree);
      yield* Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        const ledger = yield* RunLedger.RunLedger;
        yield* executor.execute(implementWorkspace, implementItem);
        const running = yield* Effect.forkChild(executor.execute(implementWorkspace, implementItem));

        yield* Deferred.await(entered);

        const runs = yield* ledger.listRuns(10);
        const completed = runs.find((run) => run.status === "succeeded");
        const inFlight = runs.find((run) => run.status === "running");
        assert.strictEqual(inFlight?.session, completed?.session);

        yield* Fiber.interrupt(running);
        assert.strictEqual((yield* Ref.get(calls)).filter((call) => call.method === "release").length, 1);
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect("ledgers the newest session when the harness starts a fresh one mid-run", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
      const restarted: ReadonlyArray<AgUiEvent> = [
        ...implementStreamEvents,
        sessionEvent("sess-99"),
        implementFinished,
      ];
      const layer = provide(recorder(calls), [runner(restarted)]);
      yield* Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        yield* executor.execute(implementWorkspace, implementItem);

        const ledger = yield* RunLedger.RunLedger;
        const [run] = yield* ledger.listRuns(10);
        assert.strictEqual(yield* handleOf(ledger, run?.session), "sess-99");
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
        const ledger = yield* RunLedger.RunLedger;
        const [run] = yield* ledger.listRuns(10);
        assert.strictEqual(captured[0]?.session, run?.session);
        assert.strictEqual(captured[1]?.session, run?.session);
        assert.strictEqual(yield* handleOf(ledger, captured[1]?.session), "sess-42");
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("starts fresh whenever the selected implement harness changes", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
      const requests = yield* Ref.make<ReadonlyArray<HarnessRequest>>([]);
      const layer = provide(recorder(calls), [
        capturingRunner(requests, implementEvents),
        capturingRunner(requests, implementEvents, Stream.empty, "opaque-handle", codex),
      ]);
      yield* Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        yield* executor.execute(implementWorkspace, implementItem);
        yield* executor.execute(codexImplementWorkspace, implementItem);
        yield* executor.execute(implementWorkspace, implementItem);

        const captured = yield* Ref.get(requests);
        assert.deepStrictEqual(
          captured.map((request) => request.harness),
          [cursor, codex, cursor],
        );
        assert.notStrictEqual(captured[0]?.session, captured[1]?.session);
        assert.notStrictEqual(captured[1]?.session, captured[2]?.session);
        assert.notStrictEqual(captured[0]?.session, captured[2]?.session);
        assert.isTrue(captured.slice(1).every((request) => !request.prompt.includes("just been resumed")));
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("resumes an interrupted run with a continuation nudge and its persisted session", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
      const requests = yield* Ref.make<ReadonlyArray<HarnessRequest>>([]);
      const ensured = yield* Ref.make<ReadonlyArray<boolean>>([]);
      const resumeItem: EligibleWork = {
        ...implementItem,
        resume: { session: previousSession, reason: "interrupted" },
      };
      const layer = provide(
        recorder(calls),
        [capturingRunner(requests, resumedImplementEvents)],
        resumeRecordingWorktree(ensured),
      );
      yield* Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        yield* seedResumeSession();
        yield* executor.execute(implementWorkspace, resumeItem);

        const captured = yield* Ref.get(requests);
        assert.strictEqual(captured.length, 1);
        const [request] = captured;
        assert.strictEqual(request?.checkoutPath, `/wt/${implementBranch}`);
        assert.strictEqual(request?.session, previousSession);
        assert.include(request?.prompt ?? "", "You were interrupted part-way through");
        assert.include(request?.prompt ?? "", `Inspect /wt/${implementBranch}`);
        assert.notInclude(request?.prompt ?? "", "implement-agent");
        assert.notInclude(request?.prompt ?? "", "IMPLEMENT-RESULT");

        assert.deepStrictEqual(yield* Ref.get(ensured), [true]);

        const log = yield* Ref.get(calls);
        assert.isTrue(log.some((c) => c.method === "implemented"));
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("cold-starts recovery when its selected harness changed", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
      const requests = yield* Ref.make<ReadonlyArray<HarnessRequest>>([]);
      const resumeItem: EligibleWork = {
        ...implementItem,
        resume: { session: previousSession, reason: "interrupted" },
      };
      const layer = provide(
        recorder(calls),
        [
          capturingRunner(requests, implementEvents),
          capturingRunner(requests, implementEvents, Stream.empty, "opaque-handle", codex),
        ],
        resumeRecordingWorktree(yield* Ref.make<ReadonlyArray<boolean>>([])),
      );
      yield* Effect.gen(function* () {
        yield* seedResumeSession();
        const executor = yield* Executor.Executor;
        yield* executor.execute(codexImplementWorkspace, resumeItem);

        const [request] = yield* Ref.get(requests);
        assert.strictEqual(request?.harness, codex);
        assert.notStrictEqual(request?.session, previousSession);
        assert.include(request?.prompt ?? "", "implement-agent");
        assert.notInclude(request?.prompt ?? "", "just been resumed");

        const callsAfterRun = yield* Ref.get(calls);
        assert.isFalse(callsAfterRun.some((call) => call.method === "attemptFailed"));

        const ledger = yield* RunLedger.RunLedger;
        const [run] = yield* ledger.listRuns(10);
        assert.strictEqual(run?.session, request?.session);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("fails a resumed implement run when the harness rejects its session", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
      const requests = yield* Ref.make<ReadonlyArray<HarnessRequest>>([]);
      const resumeItem: EligibleWork = {
        ...implementItem,
        resume: { session: previousSession, reason: "interrupted" },
      };
      const layer = provide(recorder(calls), [capturingRunner(requests, implementEvents)]);
      yield* Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        yield* seedResumeSession();
        yield* executor.execute(implementWorkspace, resumeItem);

        const captured = yield* Ref.get(requests);
        assert.strictEqual(captured.length, 1);

        const [nudge] = captured;
        assert.strictEqual(nudge?.session, previousSession);
        assert.include(nudge?.prompt ?? "", "You were interrupted part-way through");

        const log = yield* Ref.get(calls);
        assert.isTrue(log.some((c) => c.method === "attemptFailed"));
        assert.isFalse(log.some((c) => c.method === "implemented"));

        const ledger = yield* RunLedger.RunLedger;
        const [run] = yield* ledger.listRuns(10);
        assert.strictEqual(yield* handleOf(ledger, run?.session), "sess-42");
        assert.strictEqual(run?.status, "failed");
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("fails a resumed triage run when the harness rejects its session", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
      const requests = yield* Ref.make<ReadonlyArray<HarnessRequest>>([]);
      const resumeItem: EligibleWork = {
        ...triageItem,
        resume: { session: previousSession, reason: "interrupted" },
      };
      const layer = provide(recorder(calls), [capturingRunner(requests, successEvents)]);
      yield* Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        yield* seedResumeSession();
        yield* executor.execute(workspace, resumeItem);

        const captured = yield* Ref.get(requests);
        assert.strictEqual(captured.length, 1);

        const [nudge] = captured;
        assert.strictEqual(nudge?.session, previousSession);
        assert.include(nudge?.prompt ?? "", "You were interrupted part-way through");

        const log = yield* Ref.get(calls);
        assert.isTrue(log.some((c) => c.method === "attemptFailed"));
        assert.isFalse(log.some((c) => c.method === "triaged"));

        const ledger = yield* RunLedger.RunLedger;
        const [run] = yield* ledger.listRuns(10);
        assert.strictEqual(run?.status, "failed");
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
        assert.strictEqual(yield* handleOf(ledger, run?.session), "sess-42");

        yield* executor.execute(implementWorkspace, implementItem);
        const captured = yield* Ref.get(requests);
        assert.strictEqual(captured[1]?.session, run?.session);
        assert.strictEqual(yield* handleOf(ledger, captured[1]?.session), "sess-42");
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
        assert.strictEqual(log.find((c) => c.method === "attemptFailed")?.stage, "implement");
        const handOff = log.find((c) => c.method === "handOff");
        assert.strictEqual(handOff?.stage, "implement");
        assert.include(handOff?.note ?? "", "no cli");

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
        const attempt = log.find((c) => c.method === "attemptFailed");
        assert.strictEqual(attempt?.stage, "implement");
        assert.include(attempt?.reason ?? "", "diverged");
        const handOff = log.find((c) => c.method === "handOff");
        assert.strictEqual(handOff?.stage, "implement");
        assert.include(handOff?.note ?? "", "non-retryable failure");
        assert.include(handOff?.note ?? "", "diverged");

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
        assert.strictEqual(log.find((c) => c.method === "attemptFailed")?.stage, "implement");
        assert.isFalse(log.some((c) => c.method === "handOff"));

        const ledger = yield* RunLedger.RunLedger;
        const [run] = yield* ledger.listRuns(10);
        assert.strictEqual(run?.status, "failed");
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("keeps an owned transcript through a failed prepare and retry", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
      const requests = yield* Ref.make<ReadonlyArray<HarnessRequest>>([]);
      const ensures = yield* Ref.make(0);
      const worktree: WorktreeManagerService = {
        ...worktreeStubCreated(false),
        ensure: (_workspace, item) =>
          Ref.getAndUpdate(ensures, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === 1
                ? Effect.fail(
                    new GitError({ command: "fetch origin", message: "could not resolve host github.com" }),
                  )
                : Effect.succeed({
                    branch: branchName(item),
                    path: `/wt/${branchName(item)}`,
                    created: false,
                  }),
            ),
          ),
      };
      const layer = provide(
        recorder(calls),
        [capturingRunner(requests, implementEvents, Stream.empty, "owned-transcript")],
        worktree,
      );
      yield* Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        yield* executor.execute(implementWorkspace, implementItem);
        yield* executor.execute(implementWorkspace, implementItem);
        yield* executor.execute(implementWorkspace, implementItem);

        const ledger = yield* RunLedger.RunLedger;
        const runs = yield* ledger.listRuns(10);
        const succeeded = runs.find((run) => run.status === "succeeded");
        const failed = runs.find((run) => run.status === "failed");
        const captured = yield* Ref.get(requests);
        assert.strictEqual(failed?.session, succeeded?.session);
        assert.strictEqual(captured[1]?.session, succeeded?.session);
        assert.isAbove((yield* ledger.sessionEvents(succeeded?.session ?? previousSession)).length, 0);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("keeps an opaque resume handle when prepare hands a run off", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
      const ensures = yield* Ref.make(0);
      const worktree: WorktreeManagerService = {
        ...worktreeStubCreated(false),
        ensure: (_workspace, item) =>
          Ref.getAndUpdate(ensures, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === 1
                ? Effect.fail(
                    new WorktreeDivergedError({
                      remote: "origin",
                      branch: branchName(item),
                      message: "branch has diverged from origin and replaying the local commits failed",
                    }),
                  )
                : Effect.succeed({
                    branch: branchName(item),
                    path: `/wt/${branchName(item)}`,
                    created: false,
                  }),
            ),
          ),
      };
      const layer = provide(recorder(calls), [runner(implementEvents)], worktree);
      yield* Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        yield* executor.execute(implementWorkspace, implementItem);
        yield* executor.execute(implementWorkspace, implementItem);

        const ledger = yield* RunLedger.RunLedger;
        const runs = yield* ledger.listRuns(10);
        const succeeded = runs.find((run) => run.status === "succeeded");
        const exhausted = runs.find((run) => run.status === "exhausted");
        const handOff = (yield* Ref.get(calls)).find((call) => call.method === "handOff");
        assert.strictEqual(exhausted?.session, succeeded?.session);
        assert.include(handOff?.note ?? "", "agent --resume 'sess-42'");
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
        const attempt = log.find((c) => c.method === "attemptFailed");
        assert.strictEqual(attempt?.stage, "implement");
        assert.include(attempt?.reason ?? "", "brief contradicts itself");
        const handOff = log.find((c) => c.method === "handOff");
        assert.strictEqual(handOff?.stage, "implement");
        assert.include(handOff?.note ?? "", "brief contradicts itself");

        const ledger = yield* RunLedger.RunLedger;
        const [run] = yield* ledger.listRuns(10);
        assert.strictEqual(run?.status, "exhausted");
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("retries an implement run with a malformed structured result", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
      const layer = provide(recorder(calls), [runner(malformedImplementResultEvents)]);
      yield* Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        yield* executor.execute(implementWorkspace, implementItem);

        const log = yield* Ref.get(calls);
        assert.isFalse(log.some((call) => call.method === "implemented"));
        assert.include(
          log.find((call) => call.method === "attemptFailed")?.reason ?? "",
          "structured implement result",
        );
        assert.isFalse(log.some((call) => call.method === "handOff"));
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

        const log = yield* Ref.get(calls);
        const followedUp = log.find((c) => c.method === "followedUp");
        assert.strictEqual(followedUp?.checks, "failing");
        assert.isFalse(log.some((c) => c.method === "handOff"));
        assert.isTrue(log.some((c) => c.method === "release"));

        const ledger = yield* RunLedger.RunLedger;
        const [run] = yield* ledger.listRuns(10);
        assert.strictEqual(run?.stage, "follow-up");
        assert.strictEqual(run?.branch, followUpBranch);
        assert.strictEqual(run?.status, "succeeded");
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("posts the structured round summary to the pull request", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
      const posted = yield* Ref.make<ReadonlyArray<PostedComment>>([]);
      const layer = provide(
        recorder(calls),
        [runner(followUpEvents)],
        worktreeStubCreated(false),
        recordingProvider(posted),
      );
      yield* Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        yield* executor.execute(followUpWorkspace, followUpItem);

        const [comment] = yield* Ref.get(posted);
        assert.strictEqual(comment?.item, "#5");
        assert.include(comment?.body ?? "", "Fixed the failing check and pushed");
        assert.include(comment?.body ?? "", "posted by cogwork");
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("settles a successful follow-up when posting its pull request summary fails", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
      const layer = provide(
        recorder(calls),
        [runner(followUpEvents)],
        worktreeStubCreated(false),
        unavailableCommentProvider,
      );
      yield* Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        yield* executor.execute(followUpWorkspace, followUpItem);

        const log = yield* Ref.get(calls);
        assert.isTrue(log.some((call) => call.method === "followedUp"));

        const ledger = yield* RunLedger.RunLedger;
        const [run] = yield* ledger.listRuns(10);
        assert.strictEqual(run?.status, "succeeded");
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("posts no pull request summary when a follow-up hands itself off as stuck", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
      const posted = yield* Ref.make<ReadonlyArray<PostedComment>>([]);
      const layer = provide(
        recorder(calls),
        [runner(stuckFollowUpEvents)],
        worktreeStubCreated(false),
        recordingProvider(posted),
      );
      yield* Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        yield* executor.execute(followUpWorkspace, followUpItem);

        assert.isEmpty(yield* Ref.get(posted));
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect(
    "treats a noop follow-up as a non-failure that records the marker and hands back for review",
    () =>
      Effect.gen(function* () {
        const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
        const layer = provide(recorder(calls), [runner(noopFollowUpEvents)], worktreeStubCreated(false));
        yield* Effect.gen(function* () {
          const executor = yield* Executor.Executor;
          yield* executor.execute(followUpWorkspace, followUpItem);

          const log = yield* Ref.get(calls);
          const followedUp = log.find((c) => c.method === "followedUp");
          assert.strictEqual(followedUp?.checks, "failing");
          assert.isFalse(log.some((c) => c.method === "attemptFailed"));
          assert.isFalse(log.some((c) => c.method === "handOff"));
          assert.isTrue(log.some((c) => c.method === "release"));

          const ledger = yield* RunLedger.RunLedger;
          const [run] = yield* ledger.listRuns(10);
          assert.strictEqual(run?.stage, "follow-up");
          assert.strictEqual(run?.status, "succeeded");
        }).pipe(Effect.provide(layer));
      }),
  );

  it.effect("hands a self-reported stuck follow-up to a human without retrying", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
      const layer = provide(recorder(calls), [runner(stuckFollowUpEvents)], worktreeStubCreated(false));
      yield* Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        yield* executor.execute(followUpWorkspace, followUpItem);

        const log = yield* Ref.get(calls);
        const attempt = log.find((c) => c.method === "attemptFailed");
        assert.strictEqual(attempt?.stage, "follow-up");
        assert.include(attempt?.reason ?? "", "review feedback contradicts the checks");
        const handOff = log.find((c) => c.method === "handOff");
        assert.strictEqual(handOff?.stage, "follow-up");
        assert.isFalse(log.some((c) => c.method === "followedUp"));

        const ledger = yield* RunLedger.RunLedger;
        const [run] = yield* ledger.listRuns(10);
        assert.strictEqual(run?.status, "exhausted");
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("retries a follow-up with no structured result", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
      const layer = provide(
        recorder(calls),
        [runner(missingFollowUpResultEvents)],
        worktreeStubCreated(false),
      );
      yield* Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        yield* executor.execute(followUpWorkspace, followUpItem);

        const log = yield* Ref.get(calls);
        assert.include(
          log.find((call) => call.method === "attemptFailed")?.reason ?? "",
          "structured follow-up result",
        );
        assert.isFalse(log.some((call) => call.method === "handOff"));
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("retries a follow-up with a malformed structured result", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
      const layer = provide(
        recorder(calls),
        [runner(malformedFollowUpResultEvents)],
        worktreeStubCreated(false),
      );
      yield* Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        yield* executor.execute(followUpWorkspace, followUpItem);

        const log = yield* Ref.get(calls);
        assert.include(
          log.find((call) => call.method === "attemptFailed")?.reason ?? "",
          "structured follow-up result",
        );
        assert.isFalse(log.some((call) => call.method === "handOff"));
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
        const ledger = yield* RunLedger.RunLedger;
        const [run] = yield* ledger.listRuns(10);
        assert.strictEqual(captured[0]?.session, run?.session);
        assert.strictEqual(captured[1]?.session, run?.session);
        assert.strictEqual(yield* handleOf(ledger, captured[1]?.session), "sess-42");
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("mints and dispatches a new session for an explicit fresh follow-up", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
      const requests = yield* Ref.make<ReadonlyArray<HarnessRequest>>([]);
      const layer = provide(
        recorder(calls),
        [capturingRunner(requests, followUpEvents)],
        worktreeStubCreated(false),
      );
      const freshItem = {
        ...followUpItem,
        followUp: { ...followUpItem.followUp, fresh: true },
      };
      yield* Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        yield* executor.execute(followUpWorkspace, followUpItem);
        yield* executor.execute(followUpWorkspace, freshItem);

        const [freshRequest] = (yield* Ref.get(requests)).slice(-1);
        const ledger = yield* RunLedger.RunLedger;
        const [priorRun, freshRun] = yield* ledger.listRuns(10);
        assert.notStrictEqual(freshRun?.session, priorRun?.session);
        assert.strictEqual(freshRequest?.session, freshRun?.session);
        assert.include(freshRequest?.prompt ?? "", "follow-up-agent");
        assert.notInclude(freshRequest?.prompt ?? "", "You were interrupted part-way through");
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("resumes an owned-transcript follow-up by default, with no handle to lean on", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
      const requests = yield* Ref.make<ReadonlyArray<HarnessRequest>>([]);
      const layer = provide(
        recorder(calls),
        [capturingRunner(requests, ownedFollowUpEvents, Stream.empty, "owned-transcript")],
        worktreeStubCreated(false),
      );
      yield* Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        yield* executor.execute(followUpWorkspace, followUpItem);
        yield* executor.execute(followUpWorkspace, followUpItem);

        const captured = yield* Ref.get(requests);
        const ledger = yield* RunLedger.RunLedger;
        const [second, first] = yield* ledger.listRuns(10);
        assert.strictEqual(first?.session, second?.session);
        assert.strictEqual(captured[1]?.session, second?.session);
        assert.strictEqual(yield* kindOf(ledger, captured[1]?.session), "owned-transcript");
        assert.isNull(yield* handleOf(ledger, captured[1]?.session));
        assert.isAbove((yield* ledger.sessionEvents(second?.session ?? previousSession)).length, 0);
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
        const ledger = yield* RunLedger.RunLedger;
        const [priorRun, freshRun] = yield* ledger.listRuns(10);
        assert.notStrictEqual(freshRun?.session, priorRun?.session);
        assert.strictEqual(captured[1]?.session, freshRun?.session);
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
        const stalled = log.find((c) => c.method === "stalled");
        assert.isDefined(stalled);
        assert.include(stalled?.detail ?? "", "no progress");
        assert.strictEqual(stalled?.checks, "failing");
        assert.isFalse(log.some((c) => c.method === "handOff"));

        const ledger = yield* RunLedger.RunLedger;
        assert.strictEqual((yield* ledger.listRuns(10)).length, 0);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect(
    "retries an implement run with no structured result and resumes its session on the next attempt",
    () =>
      Effect.gen(function* () {
        const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
        const requests = yield* Ref.make<ReadonlyArray<HarnessRequest>>([]);
        const layer = provide(recorder(calls), [capturingRunner(requests, missingImplementResultEvents)]);
        yield* Effect.gen(function* () {
          const executor = yield* Executor.Executor;
          yield* executor.execute(implementWorkspace, implementItem);

          const log = yield* Ref.get(calls);
          const attempt = log.find((c) => c.method === "attemptFailed");
          assert.strictEqual(attempt?.stage, "implement");
          assert.include(attempt?.reason ?? "", "structured implement result");
          assert.isFalse(log.some((c) => c.method === "handOff"));

          const ledger = yield* RunLedger.RunLedger;
          const [firstRun] = yield* ledger.listRuns(10);
          assert.strictEqual(firstRun?.status, "failed");
          assert.strictEqual(yield* handleOf(ledger, firstRun?.session), "sess-42");

          yield* executor.execute(implementWorkspace, implementItem);
          const captured = yield* Ref.get(requests);
          assert.strictEqual(captured[1]?.session, firstRun?.session);
          assert.strictEqual(yield* handleOf(ledger, captured[1]?.session), "sess-42");
        }).pipe(Effect.provide(layer));
      }),
  );

  it.effect("announces the run summary when it starts, gains a session, and settles", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
      const layer = provide(recorder(calls), [runner(successEvents)]);
      yield* Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        const bus = yield* DaemonEventBus.DaemonEventBus;
        const subscription = yield* bus.subscribe();
        yield* executor.execute(workspace, triageItem);

        const events = yield* Stream.fromSubscription(subscription).pipe(
          Stream.takeUntil((event) => event._tag === "RunChanged" && event.run.status === "succeeded"),
          Stream.runCollect,
        );
        const runChanges = [...events].flatMap((event) => (event._tag === "RunChanged" ? [event.run] : []));
        assert.deepStrictEqual(
          runChanges.map((run) => run.status),
          ["running", "running", "succeeded"],
        );
        assert.isNull(runChanges[0]?.session ?? null);
        assert.isNotNull(runChanges[1]?.session ?? null);
        assert.strictEqual(runChanges[1]?.session, runChanges.at(-1)?.session);
        assert.strictEqual(runChanges.at(-1)?.eventCount, successEvents.length);
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );
});

describe("meteredTotalTokens", () => {
  it("passes a metered total straight through to the resume cap", () => {
    assert.strictEqual(Executor.meteredTotalTokens({ totalTokens: 5_000 }), 5_000);
  });

  it("withholds a best-guess estimate so it can never trip the resume cap", () => {
    assert.isNull(Executor.meteredTotalTokens({ totalTokens: 5_000, estimated: true }));
  });

  it("reports no total when usage is absent", () => {
    assert.isNull(Executor.meteredTotalTokens(null));
    assert.isNull(Executor.meteredTotalTokens(undefined));
  });
});
