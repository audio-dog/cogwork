import {
  AgUiEvent,
  BranchName,
  Connection,
  ConnectionId,
  type ContributionSettingRow,
  ControlStoreFailure,
  type ControlStore as ControlStorePicture,
  DaemonEvent,
  DeclaredVersion,
  defaultControlStore,
  type HarnessEnablement,
  HarnessName,
  LocalContribution,
  localOwnerId,
  type OperationSettingRow,
  type PluginContribution,
  type RunId,
  type SessionId,
  SessionId as SessionIdSchema,
  type SessionKind,
  sessionHandle,
  type TokenUsage,
  WorkItemId,
  WorkspaceConfig,
} from "@cogwork/contracts";

import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Metric from "effect/Metric";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type * as Tracer from "effect/Tracer";
import { TestClock } from "effect/testing";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { vi } from "vitest";
import * as Availability from "./availability";
import type { EligibleWork } from "./classify";
import { ConnectionStore, type ConnectionStoreService } from "./connection";
import * as ContextAssembler from "./context-assembler";
import { ContextFsError } from "./context-fs";
import { ControlStore, type ControlStoreService } from "./control-store";
import * as CredentialStore from "./credential-store";
import * as DaemonEventBus from "./daemon-event-bus";
import * as Executor from "./executor";
import { Git, GitError, type GitService } from "./git";
import {
  fullHarnessExecution,
  type HarnessCapabilityProfile,
  HarnessError,
  type HarnessExecution,
  type HarnessRequest,
  type HarnessRunner,
  layer as harnessLayer,
  resolvedMcpSkills,
} from "./harness";
import { HarnessReadinessCache } from "./harness-readiness";
import { IssueTracker, IssueTrackerError, type IssueTrackerService } from "./issue-tracker";
import { McpSkillAssembler } from "./mcp-skill";
import * as OperationResolution from "./operation-resolution";
import { PluginManager } from "./plugin";
import type { RegisteredWorkspace } from "./projector";
import { defaultRunBudget } from "./provider-runner";
import * as RunControl from "./run-control";
import * as RunLedger from "./run-ledger";
import { projectedContributionName } from "./run-plan";
import {
  type OpenPullRequestInput,
  SourceControlProvider,
  type SourceControlProviderService,
} from "./source-control";
import { engineTestLayer } from "./testing/engine-test-layer";
import {
  branchName,
  make as makeWorktreeManager,
  PullRequestReadiness,
  WorktreeError,
  WorktreeManager,
  type WorktreeManagerService,
  worktreePathFor,
  worktreeRoot,
} from "./worktree";
import { WorktreeFs, type WorktreeFsService } from "./worktree-fs";

const cursor = Schema.decodeSync(HarnessName)("cursor");
const codex = Schema.decodeSync(HarnessName)("codex");
const replay = Schema.decodeSync(HarnessName)("replay");
const id = Schema.decodeSync(WorkItemId);
const testObservation = { generation: 1, observedAtMillis: 1 } as const;
const linearConnectionId = Schema.decodeSync(ConnectionId)("linear/acme");
const githubConnection = Connection.make({
  id: Schema.decodeSync(ConnectionId)("github/default"),
  system: "github",
  account: "default",
  status: "established",
});

const execute = (
  executor: Effect.Success<typeof Executor.make>,
  workspace: RegisteredWorkspace,
  item: EligibleWork,
) => executor.execute(workspace, item, testObservation);

const workContext = (workItem: WorkItemId, priority: "medium" = "medium") => ({
  reference: { workItem, url: null },
  prose: { body: "", comments: [] },
  facts: { roles: [], assignees: [], openBlockers: 0, claim: null, priority, pr: null },
});
const previousSession = Schema.decodeSync(SessionIdSchema)("sess-prev");
const privateSkill = Schema.decodeSync(LocalContribution)({
  id: "local:private/skill/release",
  authority: "local:private",
  kind: "skill",
  localName: "release",
  file: "/repos/gh/.agents/skills/release/SKILL.md",
});

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
  repository: "owner/repo",
  contributions: [],
  config: Schema.decodeSync(WorkspaceConfig)({
    name: "gh",
    checkoutPath: "/repos/gh",
    issueTracker: { type: "github", connectionId: "github/default" },
  }),
};

const triageItem = {
  id: id("#7"),
  title: "broken export",
  stage: "triage" as const,
  priority: "medium" as const,
  priorFailures: 0,
  workContext: workContext(id("#7")),
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
  repository: workspace.repository,
  contributions: [privateSkill],
  config: Schema.decodeSync(WorkspaceConfig)({
    name: "gh",
    checkoutPath: "/repos/gh",
    issueTracker: { type: "github", connectionId: "github/default" },
  }),
};

const _codexImplementWorkspace: RegisteredWorkspace = {
  ...implementWorkspace,
  config: Schema.decodeSync(WorkspaceConfig)({
    ...implementWorkspace.config,
  }),
};

const mcpWorkspace: RegisteredWorkspace = {
  source: workspace.source,
  repository: workspace.repository,
  contributions: [],
  config: Schema.decodeSync(WorkspaceConfig)({
    name: "gh",
    checkoutPath: "/repos/gh",
    issueTracker: { type: "github", connectionId: "github/default" },
    mcpSkills: [{ name: "linear", endpoint: "https://mcp.linear.app/mcp/readonly" }],
  }),
};

const mcpAuthWorkspace: RegisteredWorkspace = {
  source: workspace.source,
  repository: workspace.repository,
  contributions: [],
  config: Schema.decodeSync(WorkspaceConfig)({
    name: "gh",
    checkoutPath: "/repos/gh",
    issueTracker: { type: "github", connectionId: "github/default" },
    mcpSkills: [
      { name: "linear", endpoint: "https://mcp.linear.app/mcp/readonly", auth: { type: "credential-store" } },
    ],
  }),
};

class ContextAssemblyRequests extends Context.Service<
  ContextAssemblyRequests,
  Ref.Ref<ReadonlyArray<ContextAssembler.AssembleRequest>>
>()("@cogwork/engine/executor.test/ContextAssemblyRequests") {
  static readonly layer = Layer.effect(
    ContextAssemblyRequests,
    Ref.make<ReadonlyArray<ContextAssembler.AssembleRequest>>([]),
  );
}

class ContextCleanupCalls extends Context.Service<ContextCleanupCalls, Ref.Ref<ReadonlyArray<string>>>()(
  "@cogwork/engine/executor.test/ContextCleanupCalls",
) {
  static readonly layer = Layer.effect(ContextCleanupCalls, Ref.make<ReadonlyArray<string>>([]));
  static readonly contextAssemblerLayer = Layer.effect(
    ContextAssembler.ContextAssembler,
    Effect.gen(function* () {
      const cleanups = yield* ContextCleanupCalls;
      const requests = yield* ContextAssemblyRequests;
      return {
        assemble: (request) =>
          Ref.update(requests, (calls) => [...calls, request]).pipe(
            Effect.map(() => ({
              layers: [],
              operatingInstructionsName: "implement-agent",
              operatingInstructionsPath: "/",
              operatingInstructionResources: [],
              sources: [],
            })),
          ),
        cleanup: (runId) => Ref.update(cleanups, (calls) => [...calls, runId]),
      };
    }),
  ).pipe(Layer.provideMerge(Layer.mergeAll(ContextCleanupCalls.layer, ContextAssemblyRequests.layer)));
}

const failingCleanupContext = Layer.succeed(ContextAssembler.ContextAssembler, {
  assemble: () =>
    Effect.succeed({
      layers: [],
      operatingInstructionsName: "implement-agent",
      operatingInstructionsPath: "/",
      operatingInstructionResources: [],
      sources: [],
    }),
  cleanup: () =>
    Effect.fail(
      new ContextFsError({
        operation: "remove run context",
        message: "cleanup failed",
        retryable: true,
      }),
    ),
});

const failingAssemblyContext = Layer.succeed(ContextAssembler.ContextAssembler, {
  assemble: () =>
    Effect.fail(
      new ContextFsError({
        operation: "assemble run context",
        message: "assembly failed",
        retryable: false,
      }),
    ),
  cleanup: () => Effect.void,
});

const contributionContext = Layer.succeed(ContextAssembler.ContextAssembler, {
  assemble: (request) =>
    Effect.succeed({
      layers: request.contributions
        .filter((contribution) => contribution.kind === "rules")
        .map((contribution) => ({
          kind: "rules" as const,
          source: contribution.file,
          content: contribution.id,
        })),
      operatingInstructionsName: "implement-agent",
      operatingInstructionsPath: "/",
      operatingInstructionResources: [],
      sources: [],
    }),
  cleanup: () => Effect.void,
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
  workContext: workContext(id("#15")),
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

const readyForPrEvents: ReadonlyArray<AgUiEvent> = [
  runStarted,
  sessionEvent("sess-42"),
  text("Implementation complete and ready for a pull request."),
  structuredComplete(
    {
      _tag: "implement",
      outcome: "ready-for-pr",
      summary: "Implementation complete.",
      title: "Open pull requests from the engine",
      body: "Closes #15",
    },
    '{"_tag":"implement","outcome":"ready-for-pr","summary":"Implementation complete.","title":"Open pull requests from the engine","body":"Closes #15"}',
  ),
  implementFinished,
];

const replaceSessionHandle = (event: AgUiEvent, handle: string) => {
  if (AgUiEvent.guards.CUSTOM(event) && event.name === "cursor.session-id") return sessionEvent(handle);
  return event;
};

const stuckImplementEvents: ReadonlyArray<AgUiEvent> = [
  runStarted,
  text("The brief contradicts itself; leaving for a human."),
  structuredComplete(
    { _tag: "implement", outcome: "stuck", summary: "The brief contradicts itself." },
    '{"_tag":"implement","outcome":"stuck","summary":"The brief contradicts itself."}',
  ),
  finished,
];

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
  repository: workspace.repository,
  contributions: [],
  config: Schema.decodeSync(WorkspaceConfig)({
    name: "gh",
    checkoutPath: "/repos/gh",
    issueTracker: { type: "github", connectionId: "github/default" },
  }),
};

const _codexFollowUpWorkspace: RegisteredWorkspace = {
  ...followUpWorkspace,
  config: Schema.decodeSync(WorkspaceConfig)({
    ...followUpWorkspace.config,
  }),
};

const followUpItem = {
  id: id("#5"),
  title: "PR follow-up playbook",
  stage: "follow-up" as const,
  priority: "medium" as const,
  priorFailures: 0,
  workContext: workContext(id("#5")),
  followUp: {
    previousMarker: null,
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
const externalFollowUpBranch = Schema.decodeSync(BranchName)("review/external-branch");
const externalFollowUpCheckout = "/external-checkouts/review";

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
    {
      _tag: "follow-up",
      outcome: "noop",
      summary: "The PR is green and needs no code change.",
      speak: false,
    },
    '{"_tag":"follow-up","outcome":"noop","summary":"The PR is green and needs no code change.","speak":false}',
  ),
  finished,
];

const speakingNoopFollowUpEvents: ReadonlyArray<AgUiEvent> = [
  runStarted,
  sessionEvent("sess-42"),
  text("The reported issue is expected behavior."),
  structuredComplete(
    {
      _tag: "follow-up",
      outcome: "noop",
      summary: "The reported issue is expected behavior.",
      speak: true,
    },
    '{"_tag":"follow-up","outcome":"noop","summary":"The reported issue is expected behavior.","speak":true}',
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

const disabledWorkspace: RegisteredWorkspace = {
  source: workspace.source,
  contributions: [],
  config: Schema.decodeSync(WorkspaceConfig)({
    name: "gh",
    checkoutPath: "/repos/gh",
    issueTracker: { type: "github", connectionId: "github/default" },
  }),
};

interface Call {
  readonly method: string;
  readonly item: string;
  readonly role?: string;
  readonly proposal?: string;
  readonly stage?: string;
  readonly reason?: string;
  readonly terminal?: boolean;
  readonly note?: string;
  readonly checks?: string;
  readonly detail?: string;
  readonly summary?: string;
  readonly noProgress?: number;
  readonly baseDivergence?: string;
  readonly humanCommentAtMillis?: number;
  readonly botTriggerAtMillis?: number;
  readonly latestFailingCheckAtMillis?: number;
}

class TrackerCalls extends Context.Service<TrackerCalls, Ref.Ref<ReadonlyArray<Call>>>()(
  "@cogwork/engine/executor.test/TrackerCalls",
) {
  static readonly layer = Layer.effect(TrackerCalls, Ref.make<ReadonlyArray<Call>>([]));
}

class HarnessReadinessRequests extends Context.Service<
  HarnessReadinessRequests,
  Ref.Ref<ReadonlyArray<HarnessName>>
>()("@cogwork/engine/executor.test/HarnessReadinessRequests") {}

const harnessReadinessRequestsLayer = Layer.effect(
  HarnessReadinessRequests,
  Ref.make<ReadonlyArray<HarnessName>>([]),
);

const record = (calls: Ref.Ref<ReadonlyArray<Call>>, entry: Call) =>
  Ref.update(calls, (xs) => [...xs, entry]);

const ensureClaimWriteActive = Effect.fn("ExecutorTest.ensureClaimWriteActive")(function* (
  writeActive: Ref.Ref<boolean> | undefined,
) {
  if (!writeActive) return;
  if (yield* Ref.get(writeActive)) return;
  return yield* Effect.die(new Error("Item claimed outside the Control store write gate"));
});

const recordClaim = (
  calls: Ref.Ref<ReadonlyArray<Call>>,
  itemId: string,
  claimWriteActive: Ref.Ref<boolean> | undefined,
  claimFailure: IssueTrackerError | undefined,
) =>
  ensureClaimWriteActive(claimWriteActive).pipe(
    Effect.andThen(record(calls, { method: "claim", item: itemId })),
    Effect.andThen(claimFailure ? Effect.fail(claimFailure) : Effect.void),
  );

function trackerRecorder(
  claimFailure?: IssueTrackerError,
  claimWriteActive?: Ref.Ref<boolean>,
  attemptFailure?: IssueTrackerError,
  readProse: IssueTrackerService["readProse"] = (_workspace, itemId) =>
    Effect.succeed(workContext(itemId).prose),
  handOffFailure?: IssueTrackerError,
) {
  return Layer.effect(
    IssueTracker,
    Effect.map(
      TrackerCalls,
      (calls): IssueTrackerService => ({
        rateLimitScope: () => null,
        observe: () => Effect.succeed([]),
        readProse,
        claim: (_workspace, itemId) => recordClaim(calls, itemId, claimWriteActive, claimFailure),
        release: (_workspace, itemId) => record(calls, { method: "release", item: itemId }),
        note: (_workspace, itemId, detail) => record(calls, { method: "note", item: itemId, note: detail }),
        triaged: (_workspace, itemId, outcome) =>
          record(calls, { method: "triaged", item: itemId, role: outcome.role, proposal: outcome.proposal }),
        implemented: (_workspace, itemId) => record(calls, { method: "implemented", item: itemId }),
        followedUp: (_workspace, itemId, outcome) =>
          record(calls, {
            method: "followedUp",
            item: itemId,
            checks: outcome.marker.checks,
            noProgress: outcome.marker.noProgress,
            summary: outcome.summary,
          }),
        attemptFailed: (_workspace, itemId, outcome) => {
          const recorded = record(calls, {
            method: "attemptFailed",
            item: itemId,
            stage: outcome.operation,
            reason: outcome.reason,
            baseDivergence: outcome.marker?.baseDivergence,
            noProgress: outcome.marker?.noProgress,
            humanCommentAtMillis: outcome.marker?.humanCommentAtMillis,
            botTriggerAtMillis: outcome.marker?.botTriggerAtMillis,
            latestFailingCheckAtMillis: outcome.marker?.latestFailingCheckAtMillis,
            terminal: outcome.terminal,
          });
          return attemptFailure ? recorded.pipe(Effect.andThen(Effect.fail(attemptFailure))) : recorded;
        },
        handOff: (_workspace, itemId, outcome) => {
          const recorded = record(calls, {
            method: "handOff",
            item: itemId,
            stage: outcome.stage,
            note: outcome.note,
          });
          return handOffFailure ? recorded.pipe(Effect.andThen(Effect.fail(handOffFailure))) : recorded;
        },
        handBack: () => Effect.void,
        stalled: (_workspace, itemId, outcome) =>
          record(calls, {
            method: "stalled",
            item: itemId,
            checks: outcome.marker.checks,
            detail: outcome.detail,
            noProgress: outcome.marker.noProgress,
          }),
        reclassify: () => Effect.void,
      }),
    ),
  ).pipe(Layer.provideMerge(TrackerCalls.layer));
}

class HarnessRequests extends Context.Service<HarnessRequests, Ref.Ref<ReadonlyArray<HarnessRequest>>>()(
  "@cogwork/engine/executor.test/HarnessRequests",
) {
  static readonly layer = Layer.effect(HarnessRequests, Ref.make<ReadonlyArray<HarnessRequest>>([]));
}

class HarnessGate extends Context.Service<HarnessGate, Deferred.Deferred<void>>()(
  "@cogwork/engine/executor.test/HarnessGate",
) {
  static readonly layer = Layer.effect(HarnessGate, Deferred.make<void>());
}

interface HarnessObservationState {
  readonly span: Ref.Ref<Tracer.Span | null>;
  readonly preflightEntered: Deferred.Deferred<void>;
  readonly released: Ref.Ref<boolean>;
  readonly logs: Array<{ readonly message: unknown; readonly annotations: Record<string, unknown> }>;
}

class HarnessObservation extends Context.Service<HarnessObservation, HarnessObservationState>()(
  "@cogwork/engine/executor.test/HarnessObservation",
) {
  static readonly layer = Layer.effect(
    HarnessObservation,
    Effect.all({
      span: Ref.make<Tracer.Span | null>(null),
      preflightEntered: Deferred.make<void>(),
      released: Ref.make(false),
      logs: Effect.succeed([]),
    }),
  );
}

interface TestRunner {
  readonly make: (
    requests: Ref.Ref<ReadonlyArray<HarnessRequest>>,
    gate: Deferred.Deferred<void>,
    observation: HarnessObservationState,
  ) => HarnessRunner;
}

const testRunnerDefaults = {
  capabilities: {
    authenticationModes: ["host"],
    session: { affinity: "runtime-host", fork: false, humanAttach: "codex-cli" },
    structuredOutput: "none",
    policyFidelity: "exact",
    fileEventFidelity: "absent",
    usageQuality: "none",
    readinessDiagnostics: true,
    journal: false,
    takeover: false,
  },
  authentication: { mode: "host", reference: "test login" },
  catalog: {
    models: [
      {
        value: "test",
        label: "Test",
        options: [
          {
            type: "select",
            id: "effort",
            label: "Effort",
            values: [
              { value: "low", label: "Low" },
              { value: "high", label: "High" },
            ],
            defaultValue: "high",
          },
        ],
      },
      {
        value: "refreshed-model",
        label: "Refreshed model",
        options: [
          {
            type: "select",
            id: "effort",
            label: "Effort",
            values: [
              { value: "low", label: "Low" },
              { value: "high", label: "High" },
            ],
            defaultValue: "high",
          },
        ],
      },
    ],
  },
  readiness: () =>
    Effect.succeed({
      operational: { status: "ready", retryable: false, diagnostic: "Test runner is ready" },
      installation: { status: "installed", version: "1" },
      compatibility: { status: "compatible", requirement: ">=1" },
      authentication: { mode: "host", status: "available", diagnostic: "test login available" },
      diagnostics: [],
    }),
  preflight: () => Effect.void,
} satisfies Pick<HarnessRunner, "authentication" | "capabilities" | "catalog" | "preflight" | "readiness">;

const runner = (
  events: ReadonlyArray<AgUiEvent>,
  execution: HarnessExecution = fullHarnessExecution,
  overrides: {
    readonly sessionKind?: SessionKind;
    readonly name?: HarnessName;
  } = {},
) => ({
  make: () => ({
    ...testRunnerDefaults,
    name: overrides.name ?? cursor,
    sessionKind: overrides.sessionKind ?? "opaque-handle",
    projectedMembers: [],
    planMiddleware: [],
    execution,
    run: () => Stream.fromArray(events),
  }),
});

const recordOnlyRunner = (events: ReadonlyArray<AgUiEvent>) =>
  runner(
    events,
    { ...fullHarnessExecution, profiles: ["read-only"] },
    {
      sessionKind: "owned-transcript",
      name: replay,
    },
  );

const capturingRunner = (
  events: ReadonlyArray<AgUiEvent>,
  tail: Stream.Stream<AgUiEvent, HarnessError> = Stream.empty,
  sessionKind: SessionKind = "opaque-handle",
  name: HarnessName = cursor,
  humanAttach: HarnessCapabilityProfile["session"]["humanAttach"] = "codex-cli",
  affinity: HarnessCapabilityProfile["session"]["affinity"] = "runtime-host",
): TestRunner => ({
  make: (requests) => ({
    ...testRunnerDefaults,
    capabilities: {
      ...testRunnerDefaults.capabilities,
      session: { ...testRunnerDefaults.capabilities.session, affinity, humanAttach },
    },
    name,
    sessionKind,
    projectedMembers: [],
    planMiddleware: [],
    execution: fullHarnessExecution,
    run: (request) =>
      Stream.unwrap(
        Ref.update(requests, (xs) => [...xs, request]).pipe(
          Effect.map(() => Stream.concat(Stream.fromArray(events), tail)),
        ),
      ),
  }),
});

const sequenceRunner = (streams: ReadonlyArray<Stream.Stream<AgUiEvent, HarnessError>>): TestRunner => ({
  make: (requests) => ({
    ...testRunnerDefaults,
    name: cursor,
    sessionKind: "opaque-handle",
    projectedMembers: [],
    planMiddleware: [],
    execution: fullHarnessExecution,
    run: (request) =>
      Stream.unwrap(
        Ref.modify(requests, (captured) => [
          streams[captured.length] ?? Stream.empty,
          [...captured, request],
        ]),
      ),
  }),
});

const blockedPreflightRunner: TestRunner = {
  make: (_requests, gate, observation) => ({
    ...testRunnerDefaults,
    name: cursor,
    sessionKind: "opaque-handle",
    projectedMembers: [],
    planMiddleware: [],
    execution: fullHarnessExecution,
    preflight: () =>
      Deferred.succeed(observation.preflightEntered, undefined).pipe(Effect.andThen(Deferred.await(gate))),
    run: () => Stream.fromArray(implementEvents),
  }),
};

const gatedRunner: TestRunner = {
  make: (_requests, gate) => ({
    ...testRunnerDefaults,
    name: cursor,
    sessionKind: "opaque-handle",
    projectedMembers: [],
    planMiddleware: [],
    execution: fullHarnessExecution,
    run: () =>
      Stream.concat(
        Stream.fromArray(implementStreamEvents),
        Stream.unwrap(Deferred.await(gate).pipe(Effect.map(() => Stream.fromArray([implementFinished])))),
      ),
  }),
};

const observingRunner: TestRunner = {
  make: (_requests, _gate, observation) => ({
    ...testRunnerDefaults,
    name: cursor,
    sessionKind: "opaque-handle",
    projectedMembers: [],
    planMiddleware: [],
    execution: fullHarnessExecution,
    run: () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const current = yield* Effect.currentSpan.pipe(Effect.orDie, Effect.withSpan("Harness.library"));
          yield* Ref.set(observation.span, current);
          yield* Effect.logInfo("library log", { session: "sess-42" });
          return Stream.fromArray(implementEvents);
        }),
      ),
  }),
};

const resourceRunner: TestRunner = {
  make: (_requests, _gate, observation) => ({
    ...testRunnerDefaults,
    name: cursor,
    sessionKind: "opaque-handle",
    projectedMembers: [],
    planMiddleware: [],
    execution: fullHarnessExecution,
    run: () =>
      Stream.unwrap(
        Effect.acquireRelease(Effect.succeed(Stream.fromArray(implementEvents)), () =>
          Ref.set(observation.released, true),
        ),
      ),
  }),
};

const worktreeStubCreated = (created: boolean): WorktreeManagerService => ({
  withRunOwnershipLock: (effect) => effect,
  tryWithMaintenanceLock: Effect.asSome,
  ensure: (_workspace, item) =>
    Effect.succeed({ branch: branchName(item), path: `/wt/${branchName(item)}`, created }),
  pullRequestReadiness: (_workspace, item) =>
    Effect.succeed(PullRequestReadiness.Ready({ headBranch: branchName(item), baseBranch: "main" })),
  pushBranch: () => Effect.void,
  list: () => Effect.succeed([]),
  remove: () => Effect.void,
  reconcile: () => Effect.succeed({ tornDown: [], reaped: [] }),
});

const worktreeStub = worktreeStubCreated(true);

interface WorktreeProbeState {
  readonly ensureCount: Ref.Ref<number>;
  readonly pushes: Ref.Ref<ReadonlyArray<string>>;
  readonly entered: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
}

class WorktreeProbe extends Context.Service<WorktreeProbe, WorktreeProbeState>()(
  "@cogwork/engine/executor.test/WorktreeProbe",
) {
  static readonly layer = Layer.effect(
    WorktreeProbe,
    Effect.all({
      ensureCount: Ref.make(0),
      pushes: Ref.make<ReadonlyArray<string>>([]),
      entered: Deferred.make<void>(),
      release: Deferred.make<void>(),
    }),
  );
}

const worktreeDouble = (make: (probe: WorktreeProbeState) => WorktreeManagerService) =>
  Layer.effect(WorktreeManager, Effect.map(WorktreeProbe, make)).pipe(
    Layer.provideMerge(WorktreeProbe.layer),
  );

const worktreeStubLayer: Layer.Layer<WorktreeManager | WorktreeProbe> = worktreeDouble((probe) => ({
  ...worktreeStub,
  pushBranch: (_workspace, branch) => Ref.update(probe.pushes, (pushes) => [...pushes, branch]),
}));

const cancellationWhileWaitingForOwnership = () => {
  const entered = Deferred.makeUnsafe<void>();
  const release = Deferred.makeUnsafe<void>();
  const runId = Deferred.makeUnsafe<RunId>();
  const worktree = Layer.merge(
    Layer.succeed(WorktreeManager, {
      ...worktreeStub,
      withRunOwnershipLock: (effect) =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(effect),
        ),
    } satisfies WorktreeManagerService),
    WorktreeProbe.layer,
  );
  const runControl = Layer.effect(
    RunControl.RunControl,
    Effect.map(
      RunControl.make,
      (delegate) =>
        ({
          ...delegate,
          run: (id, workspace, effect, onCancel) => {
            Deferred.doneUnsafe(runId, Effect.succeed(id));
            return delegate.run(id, workspace, effect, onCancel);
          },
        }) satisfies RunControl.RunControlService,
    ),
  );
  return { entered, runId, worktree, runControl };
};

const preparedWorktreeRemovedLayer = Layer.effect(
  Git,
  Ref.make(0).pipe(
    Effect.map(
      (listCount) =>
        ({
          fetch: () => Effect.void,
          remoteBranchExists: () => Effect.succeed(true),
          addWorktree: () => Effect.die("unexpected addWorktree"),
          removeWorktree: () => Effect.die("unexpected removeWorktree"),
          listWorktrees: () =>
            Ref.getAndUpdate(listCount, (count) => count + 1).pipe(
              Effect.map((count) =>
                count === 0
                  ? [
                      {
                        path: worktreePathFor(
                          worktreeRoot(implementWorkspace.config.checkoutPath),
                          implementBranch,
                        ),
                        branch: implementBranch,
                      },
                    ]
                  : [],
              ),
            ),
          fastForward: () => Effect.void,
          divergence: () => Effect.succeed({ ahead: 1, behind: 0 }),
          operationInProgress: () => Effect.succeed(null),
          rebase: () => Effect.die("unexpected rebase"),
          remoteUrl: () => Effect.succeed("file:///repo.git"),
          blockPush: () => Effect.void,
          allowPush: () => Effect.void,
          pushBranch: () => Effect.void,
        }) satisfies GitService,
    ),
  ),
);

const worktreeFsStub = Layer.succeed(WorktreeFs, {
  linkFile: () => Effect.void,
  removeDebris: () => Effect.succeed(true),
  runCommand: () => Effect.void,
  stat: () => Effect.succeed(null),
} satisfies WorktreeFsService);

const preparedWorktreeRemoved = Layer.merge(
  Layer.effect(WorktreeManager, makeWorktreeManager).pipe(
    Layer.provide(Layer.merge(preparedWorktreeRemovedLayer, worktreeFsStub)),
  ),
  WorktreeProbe.layer,
);

const declinedPullRequestWorktree = (reason: string) =>
  worktreeDouble(() => ({
    ...worktreeStub,
    pullRequestReadiness: () => Effect.succeed(PullRequestReadiness.Declined({ reason })),
  }));

const failedPullRequestReadinessWorktree = (failure: GitError) =>
  worktreeDouble(() => ({
    ...worktreeStub,
    pullRequestReadiness: () => Effect.fail(failure),
  }));

const failedPushWorktree = (failure: GitError) =>
  worktreeDouble(() => ({
    ...worktreeStub,
    pushBranch: () => Effect.fail(failure),
  }));

const divergedWorktree = worktreeDouble(() => ({
  ...worktreeStub,
  ensure: (_workspace, item) =>
    Effect.fail(
      new WorktreeError({
        reason: "diverged",
        remote: "origin",
        branch: branchName(item),
        message: "branch has diverged from origin and replaying the local commits failed",
        retryable: false,
      }),
    ),
}));

const externalFollowUpWorktree = worktreeDouble(() => ({
  ...worktreeStub,
  ensure: () =>
    Effect.succeed({
      branch: externalFollowUpBranch,
      path: externalFollowUpCheckout,
      created: false,
    }),
}));

const divergedExternalFollowUpWorktree = worktreeDouble(() => ({
  ...worktreeStub,
  ensure: () =>
    Effect.fail(
      new WorktreeError({
        reason: "diverged",
        remote: "origin",
        branch: externalFollowUpBranch,
        message: "branch has diverged from origin and replaying the local commits failed",
        retryable: false,
      }),
    ),
}));

const existingWorktree = worktreeDouble(() => worktreeStubCreated(false));

const interruptiblePrepareWorktree = worktreeDouble((probe) => ({
  ...worktreeStubCreated(false),
  ensure: (_workspace, item) =>
    Ref.getAndUpdate(probe.ensureCount, (count) => count + 1).pipe(
      Effect.flatMap((count) => {
        const prepared = {
          branch: branchName(item),
          path: `/wt/${branchName(item)}`,
          created: false,
        };
        if (count === 0) return Effect.succeed(prepared);
        return Deferred.succeed(probe.entered, undefined).pipe(
          Effect.andThen(Deferred.await(probe.release)),
          Effect.map(() => prepared),
        );
      }),
    ),
}));

const blockedPrepareWorktree = worktreeDouble((probe) => ({
  ...worktreeStubCreated(false),
  ensure: (_workspace, item) =>
    Deferred.succeed(probe.entered, undefined).pipe(
      Effect.andThen(Deferred.await(probe.release)),
      Effect.map(() => ({
        branch: branchName(item),
        path: `/wt/${branchName(item)}`,
        created: false,
      })),
    ),
}));

const failingRunner = (error: HarnessError): TestRunner => ({
  make: () => ({
    ...testRunnerDefaults,
    name: cursor,
    sessionKind: "opaque-handle",
    projectedMembers: [],
    planMiddleware: [],
    execution: fullHarnessExecution,
    run: () => Stream.fail(error),
  }),
});

const preflightFailingRunner = (error: HarnessError): TestRunner => ({
  make: () => ({
    ...testRunnerDefaults,
    name: cursor,
    sessionKind: "opaque-handle",
    projectedMembers: [],
    planMiddleware: [],
    execution: fullHarnessExecution,
    preflight: () => Effect.fail(error),
    run: () => Stream.die(new Error("unexpected Run after failed preflight")),
  }),
});

const delayedPreflightFailureRunner = (error: HarnessError): TestRunner => {
  const preflight = vi
    .fn<() => Effect.Effect<void, HarnessError>>()
    .mockReturnValueOnce(Effect.void)
    .mockReturnValue(Effect.fail(error));
  return {
    make: () => ({
      ...testRunnerDefaults,
      name: cursor,
      sessionKind: "opaque-handle",
      projectedMembers: [],
      planMiddleware: [],
      execution: fullHarnessExecution,
      preflight,
      run: () => Stream.die(new Error("unexpected Run after failed preflight")),
    }),
  };
};

const ownedTranscriptRunner = (events: ReadonlyArray<AgUiEvent>): TestRunner => ({
  make: () => ({
    ...testRunnerDefaults,
    name: cursor,
    sessionKind: "owned-transcript",
    projectedMembers: [],
    planMiddleware: [],
    execution: fullHarnessExecution,
    run: () => Stream.fromArray(events),
  }),
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

class PostedComments extends Context.Service<PostedComments, Ref.Ref<ReadonlyArray<PostedComment>>>()(
  "@cogwork/engine/executor.test/PostedComments",
) {
  static readonly layer = Layer.effect(PostedComments, Ref.make<ReadonlyArray<PostedComment>>([]));
}

const noopProvider: SourceControlProviderService = {
  observe: () => Effect.succeed(new Map()),
  comment: () => Effect.void,
  findOpenPullRequest: () => Effect.succeed(null),
  openPullRequest: () => Effect.succeed({ number: 1, url: "https://example.test/pull/1" }),
};

class PullRequestCalls extends Context.Service<
  PullRequestCalls,
  {
    readonly observations: Ref.Ref<number>;
    readonly opened: Ref.Ref<ReadonlyArray<OpenPullRequestInput>>;
  }
>()("@cogwork/engine/executor.test/PullRequestCalls") {
  static readonly layer = Layer.effect(
    PullRequestCalls,
    Effect.all({
      observations: Ref.make(0),
      opened: Ref.make<ReadonlyArray<OpenPullRequestInput>>([]),
    }),
  );
}

interface PullRequestProviderOptions {
  readonly existingHead?: string;
  readonly findError?: IssueTrackerError;
  readonly openError?: IssueTrackerError;
  readonly beforeOpen?: Effect.Effect<void>;
}

const pullRequestProvider = (options: PullRequestProviderOptions = {}) =>
  Layer.merge(
    Layer.effect(
      SourceControlProvider,
      Effect.map(
        PullRequestCalls,
        (probe): SourceControlProviderService => ({
          observe: () => Effect.succeed(new Map()),
          findOpenPullRequest: (_workspace, headBranch) =>
            Ref.update(probe.observations, (count) => count + 1).pipe(
              Effect.flatMap(() => {
                if (options.findError) return Effect.fail(options.findError);
                if (options.existingHead !== headBranch) return Effect.succeed(null);
                return Effect.succeed({ number: 22, url: "https://example.test/pull/22" });
              }),
            ),
          comment: () => Effect.void,
          openPullRequest: (_workspace, input) =>
            (options.beforeOpen ?? Effect.void).pipe(
              Effect.andThen(Ref.update(probe.opened, (opened) => [...opened, input])),
              Effect.flatMap(() =>
                options.openError
                  ? Effect.fail(options.openError)
                  : Effect.succeed({ number: 23, url: "https://example.test/pull/23" }),
              ),
            ),
        }),
      ),
    ),
    PostedComments.layer,
  );

const noopProviderLayer: Layer.Layer<SourceControlProvider | PostedComments> = Layer.succeed(
  SourceControlProvider,
  noopProvider,
).pipe(Layer.provideMerge(PostedComments.layer));

const conflictingProviderLayer: Layer.Layer<SourceControlProvider | PostedComments> = Layer.succeed(
  SourceControlProvider,
  {
    ...noopProvider,
    observe: () =>
      Effect.succeed(
        new Map([
          [
            id("#5"),
            {
              number: 5,
              url: "https://example.test/pull/5",
              review: "changes-requested" as const,
              checks: "failing" as const,
              latestHumanCommentAtMillis: null,
              latestBotTriggerAtMillis: null,
              latestFailingCheckAtMillis: 90,
              observedAtMillis: 1,
              fresh: false,
              baseDivergence: "conflict" as const,
              waitingSinceMillis: 0,
              headRef: "5-follow-up",
              followable: true,
              draft: false,
            },
          ],
        ]),
      ),
  },
).pipe(Layer.provideMerge(PostedComments.layer));

const clockCappedFailingProviderLayer: Layer.Layer<SourceControlProvider | PostedComments> = Layer.succeed(
  SourceControlProvider,
  {
    ...noopProvider,
    observe: () =>
      Effect.succeed(
        new Map([
          [
            id("#5"),
            {
              number: 5,
              url: "https://example.test/pull/5",
              review: "changes-requested" as const,
              checks: "failing" as const,
              latestHumanCommentAtMillis: null,
              latestBotTriggerAtMillis: null,
              latestFailingCheckAtMillis: null,
              observedAtMillis: 1,
              fresh: false,
              baseDivergence: "clean" as const,
              waitingSinceMillis: 0,
              headRef: "5-follow-up",
              followable: true,
              draft: false,
            },
          ],
        ]),
      ),
  },
).pipe(Layer.provideMerge(PostedComments.layer));

const failedObservationProviderLayer: Layer.Layer<SourceControlProvider | PostedComments> = Layer.succeed(
  SourceControlProvider,
  {
    ...noopProvider,
    observe: () =>
      Effect.fail(new IssueTrackerError({ reason: "unavailable", message: "pull request refresh failed" })),
  },
).pipe(Layer.provideMerge(PostedComments.layer));

const recordingProvider: Layer.Layer<SourceControlProvider | PostedComments> = Layer.effect(
  SourceControlProvider,
  Effect.map(
    PostedComments,
    (posted): SourceControlProviderService => ({
      observe: () => Effect.succeed(new Map()),
      comment: (_workspace, item, body) => Ref.update(posted, (xs) => [...xs, { item: item.id, body }]),
      findOpenPullRequest: () => Effect.succeed(null),
      openPullRequest: () => Effect.succeed({ number: 1, url: "https://example.test/pull/1" }),
    }),
  ),
).pipe(Layer.provideMerge(PostedComments.layer));

const unavailableCommentProvider: SourceControlProviderService = {
  observe: () => Effect.succeed(new Map()),
  comment: () =>
    Effect.fail(
      new IssueTrackerError({ reason: "unavailable", message: "GitHub comment endpoint unavailable" }),
    ),
  findOpenPullRequest: () => Effect.succeed(null),
  openPullRequest: () => Effect.succeed({ number: 1, url: "https://example.test/pull/1" }),
};

const unavailableCommentProviderLayer: Layer.Layer<SourceControlProvider | PostedComments> = Layer.succeed(
  SourceControlProvider,
  unavailableCommentProvider,
).pipe(Layer.provideMerge(PostedComments.layer));

const runControlStub = Layer.succeed(RunControl.RunControl, {
  run: (_runId, _workspace, effect) => effect,
  cancel: () => Effect.succeed(RunControl.RunCancellation.NotFound({})),
});

const harnessReadinessStub = Layer.mock(HarnessReadinessCache, {
  readiness: () => Effect.succeed({ harnesses: [], checkedAtMillis: 0 }),
  requestAll: () => Effect.void,
  requestOne: () => Effect.void,
});
const harnessReadinessRecorder = Layer.effect(
  HarnessReadinessCache,
  Effect.map(HarnessReadinessRequests, (requests) => ({
    readiness: () => Effect.succeed({ harnesses: [], checkedAtMillis: 0 }),
    requestAll: () => Effect.void,
    requestOne: (name: HarnessName) => Ref.update(requests, (names) => [...names, name]),
  })),
);
const pluginManagerStub = Layer.succeed(PluginManager, {
  overview: Effect.succeed({ plugins: [] }),
  install: () => Effect.die(new Error("unexpected Plugin install")),
  uninstall: () => Effect.die(new Error("unexpected Plugin uninstall")),
  contributions: () => Effect.succeed([]),
});

const installedPlugin = (contributions: ReadonlyArray<PluginContribution>) => ({
  pluginId: "linear",
  name: "Linear",
  summary: "Linear integration",
  record: {
    pluginId: "linear",
    resolvedIdentity: "linear@1.2.3",
    principal: localOwnerId,
    installedAtMillis: 1,
  },
  resolvedIdentity: "linear@1.2.3",
  provenanceStamp: DeclaredVersion.make({ source: "plugin:linear", version: "1.2.3" }),
  requiredConnections: [],
  contributions,
  manifestFailure: null,
});

const missingPluginCredentialContributions = [
  {
    id: "plugin:linear/mcp/linear",
    authority: "plugin:linear",
    kind: "mcp-server",
    localName: "linear",
    summary: "Linear MCP server",
    file: "/plugins/linear/mcp/linear.json",
    load: {
      _tag: "Loaded",
      mcpServer: {
        endpoint: "https://mcp.linear.app/mcp",
        secretEnv: "MISSING_LINEAR_API_KEY",
        credentialAvailable: false,
      },
    },
  },
  {
    id: "plugin:linear/rules/linear",
    authority: "plugin:linear",
    kind: "rules",
    localName: "linear",
    summary: "Linear rules",
    file: "/plugins/linear/rules/linear.md",
    load: { _tag: "Loaded" },
  },
] satisfies ReadonlyArray<PluginContribution>;

const availablePluginMcpContributions = [
  {
    id: "plugin:linear/mcp/linear",
    authority: "plugin:linear",
    kind: "mcp-server",
    localName: "linear",
    summary: "Linear MCP server",
    file: "/plugins/linear/mcp/linear.json",
    load: {
      _tag: "Loaded",
      mcpServer: {
        endpoint: "https://mcp.linear.app/mcp",
        secretEnv: null,
        credentialAvailable: true,
        connectionId: linearConnectionId,
      },
    },
  },
] satisfies ReadonlyArray<PluginContribution>;

const unavailablePluginContributions = [
  {
    id: "plugin:linear/mcp/linear",
    authority: "plugin:linear",
    kind: "mcp-server",
    localName: "linear",
    summary: "Linear MCP server",
    file: "/plugins/linear/mcp/linear.json",
    load: { _tag: "Failed", reason: "server definition is invalid" },
  },
] satisfies ReadonlyArray<PluginContribution>;

const missingPluginCredentialLayer = Layer.succeed(PluginManager, {
  overview: Effect.succeed({ plugins: [installedPlugin(missingPluginCredentialContributions)] }),
  install: () => Effect.die(new Error("unexpected Plugin install")),
  uninstall: () => Effect.die(new Error("unexpected Plugin uninstall")),
  contributions: () => Effect.succeed(missingPluginCredentialContributions),
});

const availablePluginMcpLayer = Layer.succeed(PluginManager, {
  overview: Effect.succeed({ plugins: [installedPlugin(availablePluginMcpContributions)] }),
  install: () => Effect.die(new Error("unexpected Plugin install")),
  uninstall: () => Effect.die(new Error("unexpected Plugin uninstall")),
  contributions: () => Effect.succeed(availablePluginMcpContributions),
});

const unavailablePluginLayer = Layer.succeed(PluginManager, {
  overview: Effect.succeed({ plugins: [installedPlugin(unavailablePluginContributions)] }),
  install: () => Effect.die(new Error("unexpected Plugin install")),
  uninstall: () => Effect.die(new Error("unexpected Plugin uninstall")),
  contributions: () => Effect.succeed(unavailablePluginContributions),
});

const connectionStoreService = {
  overview: Effect.succeed({
    connections: [{ system: "github", connection: githubConnection, readiness: { _tag: "Ready" } }],
  }),
  find: () => Effect.succeed(null),
  findSystem: () => Effect.succeed(null),
  bearer: () =>
    Effect.succeed({ source: "stored-key", token: Redacted.make("connection-token"), identity: null }),
  readiness: () => Effect.succeed({ _tag: "Ready" }),
  requireReady: () => Effect.void,
  requireSystemReady: () => Effect.void,
  establish: () => Effect.die(new Error("unexpected Connection establishment")),
  revoke: () => Effect.die(new Error("unexpected Connection revocation")),
  remove: () => Effect.die(new Error("unexpected Connection removal")),
} satisfies ConnectionStoreService;

const connectionStoreStub = Layer.succeed(ConnectionStore, connectionStoreService);

const stagesEnabled: OperationSettingRow = {
  setting: "enabled",
  level: { _tag: "Default" },
  scope: { _tag: "SettingsProfile" },
  value: true,
};

const cursorHarness: OperationSettingRow = {
  setting: "harness",
  level: { _tag: "Default" },
  scope: { _tag: "SettingsProfile" },
  value: "cursor",
};

const replayHarness: OperationSettingRow = {
  ...cursorHarness,
  value: "replay",
};

const runnableStages = [stagesEnabled, cursorHarness];
const runnableReplayStages = [stagesEnabled, replayHarness];

const controlStoreLayer = (
  operationSettings: ReadonlyArray<OperationSettingRow>,
  contributionSettings: ReadonlyArray<ContributionSettingRow> = [],
  harnessSettings: ReadonlyArray<HarnessEnablement> = [],
  read: Effect.Effect<ControlStorePicture, ControlStoreFailure, never> | null = null,
) => {
  const picture = { ...defaultControlStore, operationSettings, contributionSettings, harnessSettings };
  const gate = Semaphore.makeUnsafe(1);
  return Layer.succeed(ControlStore, {
    health: "available",
    seed: picture,
    picture: read ?? Effect.succeed(picture),
    setDaemonLimit: () => Effect.die(new Error("unexpected daemon limit update")),
    establishConnection: () => Effect.die(new Error("unexpected Connection establishment")),
    revokeConnection: () => Effect.die(new Error("unexpected Connection revocation")),
    removeConnection: () => Effect.die(new Error("unexpected Connection removal")),
    setHarnessEnabled: () => Effect.die(new Error("unexpected Harness enablement update")),
    updateOperationSettings: () => Effect.die(new Error("unexpected operation setting update")),
    installPlugin: () => Effect.die(new Error("unexpected Plugin install")),
    uninstallPlugin: () => Effect.die(new Error("unexpected Plugin uninstall")),
    updateContributionSetting: () => Effect.die(new Error("unexpected contribution setting update")),
    withWrite: <A, E, R>(effect: Effect.Effect<A, E, R>) => gate.withPermits(1)(effect),
  } satisfies ControlStoreService);
};

function mutableHarnessControlStoreLayer(settings: Ref.Ref<ReadonlyArray<HarnessEnablement>>) {
  const gate = Semaphore.makeUnsafe(1);
  return Layer.succeed(ControlStore, {
    health: "available",
    seed: { ...defaultControlStore, operationSettings: runnableStages },
    picture: Ref.get(settings).pipe(
      Effect.map((harnessSettings) => ({
        ...defaultControlStore,
        operationSettings: runnableStages,
        harnessSettings,
      })),
    ),
    setDaemonLimit: () => Effect.die(new Error("unexpected daemon limit update")),
    establishConnection: () => Effect.die(new Error("unexpected Connection establishment")),
    revokeConnection: () => Effect.die(new Error("unexpected Connection revocation")),
    removeConnection: () => Effect.die(new Error("unexpected Connection removal")),
    setHarnessEnabled: (harness, enabled) =>
      Ref.update(settings, (current) => [
        ...current.filter((setting) => setting.harness !== harness),
        ...(enabled ? [] : [{ harness, enabled }]),
      ]).pipe(
        Effect.andThen(Ref.get(settings)),
        Effect.map((harnessSettings) => ({
          ...defaultControlStore,
          operationSettings: runnableStages,
          harnessSettings,
        })),
      ),
    updateOperationSettings: () => Effect.die(new Error("unexpected operation setting update")),
    installPlugin: () => Effect.die(new Error("unexpected Plugin install")),
    uninstallPlugin: () => Effect.die(new Error("unexpected Plugin uninstall")),
    updateContributionSetting: () => Effect.die(new Error("unexpected contribution setting update")),
    withWrite: <A, E, R>(effect: Effect.Effect<A, E, R>) => gate.withPermits(1)(effect),
  } satisfies ControlStoreService);
}

const changingControlStoreLayer = (
  firstOperationSettings: ReadonlyArray<OperationSettingRow>,
  secondOperationSettings: ReadonlyArray<OperationSettingRow>,
  firstContributionSettings: ReadonlyArray<ContributionSettingRow> = [],
  secondContributionSettings: ReadonlyArray<ContributionSettingRow> = [],
) =>
  Layer.effect(
    ControlStore,
    Effect.gen(function* () {
      const writeActive = yield* Ref.make(false);
      const picture = (
        operationSettings: ReadonlyArray<OperationSettingRow>,
        contributionSettings: ReadonlyArray<ContributionSettingRow>,
      ) => ({
        ...defaultControlStore,
        operationSettings,
        contributionSettings,
      });
      return {
        health: "available" as const,
        seed: picture(firstOperationSettings, firstContributionSettings),
        picture: Ref.get(writeActive).pipe(
          Effect.flatMap((active) =>
            active
              ? Effect.succeed(picture(secondOperationSettings, secondContributionSettings))
              : Effect.succeed(picture(firstOperationSettings, firstContributionSettings)),
          ),
        ),
        setDaemonLimit: () => Effect.die(new Error("unexpected daemon limit update")),
        establishConnection: () => Effect.die(new Error("unexpected Connection establishment")),
        revokeConnection: () => Effect.die(new Error("unexpected Connection revocation")),
        removeConnection: () => Effect.die(new Error("unexpected Connection removal")),
        setHarnessEnabled: () => Effect.die(new Error("unexpected Harness enablement update")),
        updateOperationSettings: () => Effect.die(new Error("unexpected operation setting update")),
        installPlugin: () => Effect.die(new Error("unexpected Plugin install")),
        uninstallPlugin: () => Effect.die(new Error("unexpected Plugin uninstall")),
        updateContributionSetting: () => Effect.die(new Error("unexpected contribution setting update")),
        withWrite: (effect) =>
          Ref.set(writeActive, true).pipe(
            Effect.andThen(effect),
            Effect.ensuring(Ref.set(writeActive, false)),
          ),
      };
    }),
  );

function testHarness(runners: ReadonlyArray<TestRunner>) {
  return Layer.unwrap(
    Effect.gen(function* () {
      const requests = yield* HarnessRequests;
      const gate = yield* HarnessGate;
      const observation = yield* HarnessObservation;
      return harnessLayer(runners.map((runner) => runner.make(requests, gate, observation)));
    }),
  ).pipe(
    Layer.provideMerge(Layer.mergeAll(HarnessRequests.layer, HarnessGate.layer, HarnessObservation.layer)),
  );
}

const runLedgerIdentity = (layer: Layer.Layer<RunLedger.RunLedger>) => layer;

const failRunAcceptance = (retryable: boolean) => (layer: Layer.Layer<RunLedger.RunLedger>) =>
  Layer.effect(
    RunLedger.RunLedger,
    Effect.gen(function* () {
      const ledger = yield* RunLedger.RunLedger;
      return {
        ...ledger,
        acceptRun: () =>
          Effect.fail(
            RunLedger.RunLedgerError.make({
              operation: RunLedger.acceptRunOperation,
              message: "persistence rejected",
              retryable,
            }),
          ),
      } satisfies RunLedger.RunLedgerService;
    }),
  ).pipe(Layer.provide(layer));

const assertRunAcceptanceInsideWriteGate =
  (writeActive: Ref.Ref<boolean>) => (layer: Layer.Layer<RunLedger.RunLedger>) =>
    Layer.effect(
      RunLedger.RunLedger,
      Effect.gen(function* () {
        const ledger = yield* RunLedger.RunLedger;
        return {
          ...ledger,
          acceptRun: (record, plan) =>
            Ref.get(writeActive).pipe(
              Effect.flatMap((active) =>
                active
                  ? ledger.acceptRun(record, plan)
                  : Effect.die(new Error("Run accepted outside the Control store write gate")),
              ),
            ),
        } satisfies RunLedger.RunLedgerService;
      }),
    ).pipe(Layer.provide(layer));

const observedWriteGateControlStoreLayer = (writeActive: Ref.Ref<boolean>) => {
  const gate = Semaphore.makeUnsafe(1);
  const picture = { ...defaultControlStore, operationSettings: runnableStages };
  return Layer.succeed(ControlStore, {
    health: "available",
    seed: picture,
    picture: Effect.succeed(picture),
    setDaemonLimit: () => Effect.die(new Error("unexpected daemon limit update")),
    establishConnection: () => Effect.die(new Error("unexpected Connection establishment")),
    revokeConnection: () => Effect.die(new Error("unexpected Connection revocation")),
    removeConnection: () => Effect.die(new Error("unexpected Connection removal")),
    setHarnessEnabled: () => Effect.die(new Error("unexpected Harness enablement update")),
    updateOperationSettings: () => Effect.die(new Error("unexpected operation setting update")),
    installPlugin: () => Effect.die(new Error("unexpected Plugin install")),
    uninstallPlugin: () => Effect.die(new Error("unexpected Plugin uninstall")),
    updateContributionSetting: () => Effect.die(new Error("unexpected contribution setting update")),
    withWrite: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      gate.withPermits(1)(
        Ref.set(writeActive, true).pipe(Effect.andThen(effect), Effect.ensuring(Ref.set(writeActive, false))),
      ),
  } satisfies ControlStoreService);
};

function provide<SourceControlRequirements = never>(
  runners: ReadonlyArray<TestRunner>,
  worktree: Layer.Layer<WorktreeManager | WorktreeProbe> = worktreeStubLayer,
  sourceControl: Layer.Layer<
    SourceControlProvider | PostedComments,
    never,
    SourceControlRequirements
  > = noopProviderLayer,
  issueTracker: Layer.Layer<IssueTracker | TrackerCalls> = trackerRecorder(),
  operationSettings: ReadonlyArray<OperationSettingRow> = runnableStages,
  contextAssembler: Layer.Layer<ContextAssembler.ContextAssembler> = ContextCleanupCalls.contextAssemblerLayer,
  plugins: Layer.Layer<PluginManager> = pluginManagerStub,
  contributionSettings: ReadonlyArray<ContributionSettingRow> = [],
  controlStore: ReturnType<typeof controlStoreLayer> = controlStoreLayer(
    operationSettings,
    contributionSettings,
  ),
  transformRunLedger: (
    layer: Layer.Layer<RunLedger.RunLedger>,
  ) => Layer.Layer<RunLedger.RunLedger> = runLedgerIdentity,
  connections = connectionStoreStub,
  runControl: Layer.Layer<RunControl.RunControl> = runControlStub,
  harnessReadiness: Layer.Layer<HarnessReadinessCache> = harnessReadinessStub,
) {
  const engineServices = engineTestLayer({ transformRunLedger });
  const operationResolution = OperationResolution.layer;
  const executor = Layer.effect(Executor.Executor, Executor.make).pipe(Layer.provide(operationResolution));
  const runnerServices = Layer.mergeAll(
    engineServices,
    contextAssembler,
    CredentialStore.layerEnv,
    FileSystem.layerNoop({}),
    FetchHttpClient.layer,
  );
  return Layer.merge(executor, operationResolution).pipe(
    Layer.provide(Availability.Availability.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        issueTracker,
        sourceControl,
        testHarness(runners),
        runnerServices,
        ContextCleanupCalls.layer,
        ContextAssemblyRequests.layer,
        runControl,
        worktree,
        assemblerStub,
        contextAssembler,
        controlStore,
        plugins,
        FileSystem.layerNoop({ exists: () => Effect.succeed(true) }),
        connections,
        harnessReadiness,
      ),
    ),
  );
}

const provideReplay = (runners: ReadonlyArray<TestRunner>) =>
  provide(runners, worktreeStubLayer, noopProviderLayer, trackerRecorder(), runnableReplayStages);

const provideWithHarnessReadiness = (runners: ReadonlyArray<TestRunner>) => {
  const requests = harnessReadinessRequestsLayer;
  const harnessReadiness = harnessReadinessRecorder.pipe(Layer.provide(requests));
  return provide(
    runners,
    worktreeStubLayer,
    noopProviderLayer,
    trackerRecorder(),
    runnableStages,
    ContextCleanupCalls.contextAssemblerLayer,
    pluginManagerStub,
    [],
    controlStoreLayer(runnableStages),
    runLedgerIdentity,
    connectionStoreStub,
    runControlStub,
    harnessReadiness,
  ).pipe(Layer.provideMerge(requests));
};

describe("Executor.execute", () => {
  it.effect("projects availability only for executable Operations", () => {
    return Effect.gen(function* () {
      const resolution = yield* OperationResolution.OperationResolution;
      const availability = yield* resolution.refreshAvailability(workspace);

      assert.deepStrictEqual(
        availability.map(({ operation }) => operation),
        ["triage", "implement", "follow-up"],
      );
    }).pipe(Effect.provide(provide([runner(successEvents)])));
  });

  it.effect("preflights each distinct Harness configuration once per availability refresh", () =>
    Effect.gen(function* () {
      const preflights = yield* Ref.make(0);
      const operationSettings: ReadonlyArray<OperationSettingRow> = [
        ...runnableStages,
        {
          setting: "model-options",
          level: { _tag: "Operation", workflow: "coding", operation: "implement" },
          scope: { _tag: "SettingsProfile" },
          value: { effort: "high" },
        },
        {
          setting: "model-options",
          level: { _tag: "Operation", workflow: "coding", operation: "follow-up" },
          scope: { _tag: "SettingsProfile" },
          value: { effort: "low" },
        },
      ];
      const probeRunner: TestRunner = {
        make: () => ({
          ...testRunnerDefaults,
          name: cursor,
          sessionKind: "opaque-handle",
          projectedMembers: [],
          planMiddleware: [],
          execution: fullHarnessExecution,
          preflight: () => Ref.update(preflights, (count) => count + 1),
          run: () => Stream.fromArray(implementEvents),
        }),
      };

      yield* OperationResolution.OperationResolution.pipe(
        Effect.flatMap((resolution) => resolution.refreshAvailability(workspace)),
        Effect.provide(
          provide([probeRunner], worktreeStubLayer, noopProviderLayer, trackerRecorder(), operationSettings),
        ),
      );

      assert.strictEqual(yield* Ref.get(preflights), 3);
    }),
  );

  it.effect("keeps transient Harness preflight failures out of availability", () => {
    const transientPreflight: TestRunner = {
      make: () => ({
        ...testRunnerDefaults,
        name: cursor,
        sessionKind: "opaque-handle",
        projectedMembers: [],
        planMiddleware: [],
        execution: fullHarnessExecution,
        preflight: () =>
          Effect.fail(
            new HarnessError({
              reason: "launch",
              retryable: true,
              message: "readiness check timed out",
            }),
          ),
        run: () => Stream.fromArray(implementEvents),
      }),
    };

    return Effect.gen(function* () {
      const resolution = yield* OperationResolution.OperationResolution;
      const availability = yield* resolution.availabilityOf(implementWorkspace, implementItem);

      assert.isTrue(availability.available);
      assert.deepStrictEqual(availability.causes, []);
    }).pipe(Effect.provide(provide([transientPreflight])));
  });

  it.effect("declines an operation whose issue-tracker Connection is not ready", () => {
    const notReadyConnections = Layer.succeed(ConnectionStore, {
      ...connectionStoreService,
      overview: Effect.succeed({
        connections: [
          {
            system: "github",
            connection: githubConnection,
            readiness: { _tag: "NotReady", reason: "credential expired" },
          },
        ],
      }),
    } satisfies ConnectionStoreService);

    return Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const resolution = yield* OperationResolution.OperationResolution;
      const executor = yield* Executor.Executor;
      const availability = yield* resolution.availabilityOf(implementWorkspace, implementItem);

      assert.isFalse(availability.available);
      assert.deepStrictEqual(availability.causes, [
        {
          _tag: "UnsatisfiedNeed",
          need: "issue-tracker-connection",
          kind: "connection",
          reason: "not-ready",
          contribution: "github/default",
          message: "credential expired",
        },
      ]);
      assert.isFalse(yield* execute(executor, implementWorkspace, implementItem));
      assert.deepStrictEqual(yield* Ref.get(calls), []);
    }).pipe(
      Effect.provide(
        provide(
          [runner(implementEvents)],
          worktreeStubLayer,
          noopProviderLayer,
          trackerRecorder(),
          runnableStages,
          ContextCleanupCalls.contextAssemblerLayer,
          pluginManagerStub,
          [],
          controlStoreLayer(runnableStages),
          runLedgerIdentity,
          notReadyConnections,
        ),
      ),
    );
  });

  it.effect("releases the claim when the issue-tracker Connection expires during preparation", () =>
    Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const requests = yield* HarnessRequests;
      const executor = yield* Executor.Executor;

      assert.isTrue(yield* execute(executor, implementWorkspace, implementItem));
      assert.deepStrictEqual(yield* Ref.get(calls), [
        { method: "claim", item: "#15" },
        { method: "release", item: "#15" },
      ]);
      assert.deepStrictEqual(yield* Ref.get(requests), []);
    }).pipe(
      Effect.provide(
        provide(
          [runner(implementEvents)],
          worktreeStubLayer,
          noopProviderLayer,
          trackerRecorder(),
          runnableStages,
          ContextCleanupCalls.contextAssemblerLayer,
          pluginManagerStub,
          [],
          controlStoreLayer(runnableStages),
          runLedgerIdentity,
          Layer.effect(
            ConnectionStore,
            Effect.gen(function* () {
              const reads = yield* Ref.make(0);
              return {
                ...connectionStoreService,
                overview: Ref.getAndUpdate(reads, (count) => count + 1).pipe(
                  Effect.map((count) => ({
                    connections: [
                      {
                        system: "github" as const,
                        connection: githubConnection,
                        readiness:
                          count === 0
                            ? ({ _tag: "Ready" } as const)
                            : ({ _tag: "NotReady", reason: "credential expired" } as const),
                      },
                    ],
                  })),
                ),
              } satisfies ConnectionStoreService;
            }),
          ),
        ),
      ),
    ),
  );

  it.effect("releases the claim and holds off another claim when admission fails", () =>
    Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const requests = yield* HarnessRequests;
      const executor = yield* Executor.Executor;

      assert.isFalse(yield* execute(executor, implementWorkspace, implementItem));
      assert.isFalse(yield* execute(executor, implementWorkspace, implementItem));
      yield* TestClock.adjust("1 minute");
      assert.isFalse(yield* execute(executor, implementWorkspace, implementItem));
      yield* TestClock.adjust("1 minute");
      assert.isFalse(yield* execute(executor, implementWorkspace, implementItem));
      assert.deepStrictEqual(yield* Ref.get(calls), [
        { method: "claim", item: "#15" },
        { method: "release", item: "#15" },
        { method: "claim", item: "#15" },
        { method: "release", item: "#15" },
      ]);
      assert.deepStrictEqual(yield* Ref.get(requests), []);
    }).pipe(
      Effect.provide(
        provide(
          [runner(implementEvents)],
          worktreeStubLayer,
          noopProviderLayer,
          trackerRecorder(undefined, undefined, undefined, () =>
            Effect.fail(
              new IssueTrackerError({ reason: "auth", message: "issue-tracker credential expired" }),
            ),
          ),
          runnableStages,
        ),
      ),
    ),
  );

  it.effect("hands off a permanent admission prose failure", () =>
    Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const executor = yield* Executor.Executor;

      assert.isFalse(yield* execute(executor, implementWorkspace, implementItem));
      assert.deepStrictEqual(yield* Ref.get(calls), [
        { method: "claim", item: "#15" },
        { method: "release", item: "#15" },
        {
          method: "handOff",
          item: "#15",
          stage: "implement",
          note: "Work Context admission failed: issue thread is too large",
        },
      ]);
    }).pipe(
      Effect.provide(
        provide(
          [runner(implementEvents)],
          worktreeStubLayer,
          noopProviderLayer,
          trackerRecorder(undefined, undefined, undefined, () =>
            Effect.fail(
              new IssueTrackerError({
                reason: "unavailable",
                retryable: false,
                message: "issue thread is too large",
              }),
            ),
          ),
          runnableStages,
        ),
      ),
    ),
  );

  it.effect("returns false when permanent admission handoff fails", () =>
    Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const executor = yield* Executor.Executor;

      assert.isFalse(yield* execute(executor, implementWorkspace, implementItem));
      assert.deepStrictEqual(yield* Ref.get(calls), [
        { method: "claim", item: "#15" },
        { method: "release", item: "#15" },
        {
          method: "handOff",
          item: "#15",
          stage: "implement",
          note: "Work Context admission failed: issue thread is too large",
        },
      ]);
    }).pipe(
      Effect.provide(
        provide(
          [runner(implementEvents)],
          worktreeStubLayer,
          noopProviderLayer,
          trackerRecorder(
            undefined,
            undefined,
            undefined,
            () =>
              Effect.fail(
                new IssueTrackerError({
                  reason: "unavailable",
                  retryable: false,
                  message: "issue thread is too large",
                }),
              ),
            new IssueTrackerError({ reason: "auth", message: "issue-tracker credential expired" }),
          ),
          runnableStages,
        ),
      ),
    ),
  );

  it.effect("releases the claim when the admission prose read defects", () =>
    Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const executor = yield* Executor.Executor;

      const exit = yield* Effect.exit(execute(executor, implementWorkspace, implementItem));
      assert.strictEqual(exit._tag, "Failure");
      assert.deepStrictEqual(yield* Ref.get(calls), [
        { method: "claim", item: "#15" },
        { method: "release", item: "#15" },
      ]);
    }).pipe(
      Effect.provide(
        provide(
          [runner(implementEvents)],
          worktreeStubLayer,
          noopProviderLayer,
          trackerRecorder(undefined, undefined, undefined, () => Effect.die(new Error("prose defect"))),
          runnableStages,
        ),
      ),
    ),
  );

  it.effect("freezes prose read after claim into the Harness request", () =>
    Effect.gen(function* () {
      const requests = yield* HarnessRequests;
      const executor = yield* Executor.Executor;
      yield* execute(executor, implementWorkspace, implementItem);
      const [request] = yield* Ref.get(requests);
      const prose = request?.plan.workContext.prose;
      assert.deepStrictEqual(
        prose ? { body: prose.body, comments: prose.comments.map((comment) => ({ ...comment })) } : undefined,
        {
          body: "Body read at admission",
          comments: [
            {
              author: "maintainer",
              authorAssociation: "MEMBER",
              body: "Latest steer",
              createdAtMillis: 2,
            },
          ],
        },
      );
    }).pipe(
      Effect.provide(
        provide(
          [capturingRunner(implementEvents)],
          worktreeStubLayer,
          noopProviderLayer,
          trackerRecorder(undefined, undefined, undefined, () =>
            Effect.succeed({
              body: "Body read at admission",
              comments: [
                {
                  author: "maintainer",
                  authorAssociation: "MEMBER",
                  body: "Latest steer",
                  createdAtMillis: 2,
                },
              ],
            }),
          ),
          runnableStages,
        ),
      ),
    ),
  );

  it.effect("releases the claim when admission prose reading is interrupted", () => {
    const entered = Deferred.makeUnsafe<void>();
    return Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const executor = yield* Executor.Executor;
      const running = yield* Effect.forkChild(execute(executor, implementWorkspace, implementItem));
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(running);
      assert.deepStrictEqual(yield* Ref.get(calls), [
        { method: "claim", item: "#15" },
        { method: "release", item: "#15" },
      ]);
    }).pipe(
      Effect.provide(
        provide(
          [runner(implementEvents)],
          worktreeStubLayer,
          noopProviderLayer,
          trackerRecorder(undefined, undefined, undefined, () =>
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
          ),
          runnableStages,
        ),
      ),
      Effect.scoped,
    );
  });

  it.effect("declines when the Harness enablement reread fails", () => {
    const reads = Ref.makeUnsafe(0);
    const picture = { ...defaultControlStore, operationSettings: runnableStages };
    const failure = ControlStoreFailure.make({
      operation: "read Control store",
      message: "store read failed",
      retryable: true,
    });
    return Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const requests = yield* HarnessRequests;
      const executor = yield* Executor.Executor;

      assert.isFalse(yield* execute(executor, implementWorkspace, implementItem));
      assert.deepStrictEqual(yield* Ref.get(calls), []);
      assert.deepStrictEqual(yield* Ref.get(requests), []);
    }).pipe(
      Effect.provide(
        provide(
          [runner(implementEvents)],
          worktreeStubLayer,
          noopProviderLayer,
          trackerRecorder(),
          runnableStages,
          ContextCleanupCalls.contextAssemblerLayer,
          pluginManagerStub,
          [],
          controlStoreLayer(
            runnableStages,
            [],
            [],
            Ref.getAndUpdate(reads, (count) => count + 1).pipe(
              Effect.flatMap((count) => (count === 0 ? Effect.succeed(picture) : Effect.fail(failure))),
            ),
          ),
        ),
      ),
    );
  });

  it.effect("declines a stalled follow-up when Harness enablement cannot be read", () => {
    const stalledItem = {
      ...followUpItem,
      followUp: { ...followUpItem.followUp, noProgress: 3, stalled: true },
    };
    return Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const executor = yield* Executor.Executor;

      assert.isFalse(yield* execute(executor, followUpWorkspace, stalledItem));
      assert.deepStrictEqual(yield* Ref.get(calls), []);
    }).pipe(
      Effect.provide(
        provide(
          [capturingRunner(followUpEvents)],
          worktreeStubLayer,
          noopProviderLayer,
          trackerRecorder(),
          runnableStages,
          ContextCleanupCalls.contextAssemblerLayer,
          pluginManagerStub,
          [],
          controlStoreLayer(
            runnableStages,
            [],
            [],
            Effect.fail(
              ControlStoreFailure.make({
                operation: "read Control store",
                message: "store read failed",
                retryable: true,
              }),
            ),
          ),
        ),
      ),
    );
  });

  it.effect("refuses a disabled Harness before claim", () =>
    Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const requests = yield* HarnessRequests;
      const resolution = yield* OperationResolution.OperationResolution;
      const executor = yield* Executor.Executor;
      const availability = yield* resolution.availabilityOf(implementWorkspace, implementItem);
      const accepted = yield* execute(executor, implementWorkspace, implementItem);

      assert.isFalse(availability.available);
      assert.isFalse(accepted);
      assert.deepStrictEqual(yield* Ref.get(calls), []);
      assert.deepStrictEqual(yield* Ref.get(requests), []);
      assert.deepStrictEqual(availability.causes, [
        {
          _tag: "RuntimeHostFactFailed",
          fact: "harness",
          message: "cursor Harness is disabled on this Runtime host",
        },
      ]);
    }).pipe(
      Effect.provide(
        provide(
          [runner(successEvents), runner(implementEvents, fullHarnessExecution, { name: codex })],
          worktreeStubLayer,
          noopProviderLayer,
          trackerRecorder(),
          runnableStages,
          ContextCleanupCalls.contextAssemblerLayer,
          pluginManagerStub,
          [],
          controlStoreLayer(runnableStages, [], [{ harness: cursor, enabled: false }]),
        ),
      ),
    ),
  );

  it.effect("refuses a resumed Run on a disabled Harness before claim", () => {
    const resumedItem = {
      ...implementItem,
      resume: { session: previousSession, reason: "interrupted" },
    } satisfies EligibleWork;

    return Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const requests = yield* HarnessRequests;
      const executor = yield* Executor.Executor;

      assert.isFalse(yield* execute(executor, implementWorkspace, resumedItem));
      assert.isFalse((yield* Ref.get(calls)).some((call) => call.method === "claim"));
      assert.strictEqual((yield* Ref.get(requests)).length, 0);
    }).pipe(
      Effect.provide(
        provide(
          [capturingRunner(implementEvents)],
          worktreeStubLayer,
          noopProviderLayer,
          trackerRecorder(),
          runnableStages,
          ContextCleanupCalls.contextAssemblerLayer,
          pluginManagerStub,
          [],
          controlStoreLayer(runnableStages, [], [{ harness: cursor, enabled: false }]),
        ),
      ),
    );
  });

  it.effect("admits the selected Harness again after it is enabled", () => {
    const settings = Ref.makeUnsafe<ReadonlyArray<HarnessEnablement>>([{ harness: cursor, enabled: false }]);

    return Effect.gen(function* () {
      const requests = yield* HarnessRequests;
      const executor = yield* Executor.Executor;
      const store = yield* ControlStore;

      assert.isFalse(yield* execute(executor, implementWorkspace, implementItem));
      yield* store.withWrite(store.setHarnessEnabled(cursor, true));
      assert.isTrue(yield* execute(executor, implementWorkspace, implementItem));
      assert.strictEqual((yield* Ref.get(requests)).length, 1);
    }).pipe(
      Effect.provide(
        provide(
          [capturingRunner(implementEvents)],
          worktreeStubLayer,
          noopProviderLayer,
          trackerRecorder(),
          runnableStages,
          ContextCleanupCalls.contextAssemblerLayer,
          pluginManagerStub,
          [],
          mutableHarnessControlStoreLayer(settings),
        ),
      ),
    );
  });

  it.effect("triages an eligible item into a proposal note, label advance, and ledgered run", () => {
    return Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const requests = yield* HarnessRequests;
      const executor = yield* Executor.Executor;
      const before = (yield* Metric.value(Executor.harnessEventFoldDuration)).count;
      yield* execute(executor, workspace, triageItem);
      assert.isAbove((yield* Metric.value(Executor.harnessEventFoldDuration)).count, before);

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

      const plan = firstRun ? yield* ledger.getRunPlan(firstRun.id) : null;
      const [request] = yield* Ref.get(requests);
      assert.isNotNull(plan);
      assert.deepStrictEqual(request?.plan, plan);
      assert.deepStrictEqual(
        plan?.messages.map(({ role, content }) => ({ role, content })),
        [{ role: "user", content: request?.plan.messages[0]?.content }],
      );
      assert.isTrue(
        plan?.instructions.every((instruction) => instruction.content !== request?.plan.messages[0]?.content),
      );

      const events = firstRun ? yield* ledger.events(firstRun.id).pipe(Stream.runCollect) : [];
      assert.strictEqual(events.length, successEvents.length);
      assert.deepStrictEqual(
        events.map((e) => e.seq),
        successEvents.map((_, i) => i),
      );
      assert.strictEqual(events.at(-2)?.name, "structured-output.complete");
      assert.strictEqual(events.at(-1)?.type, "RUN_FINISHED");
    }).pipe(Effect.provide(provide([capturingRunner(successEvents)])));
  });

  it.effect("retries a triage run that emits no structured result", () => {
    return Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const executor = yield* Executor.Executor;
      yield* execute(executor, workspace, triageItem);
      const log = yield* Ref.get(calls);
      assert.isFalse(log.some((call) => call.method === "triaged"));
      assert.include(log.find((call) => call.method === "attemptFailed")?.reason ?? "", "structured");
    }).pipe(Effect.provide(provide([runner([text("I could not produce a result."), finished])])));
  });

  it.effect("settles a run when an event cannot be encoded", () =>
    Effect.gen(function* () {
      const executor = yield* Executor.Executor;
      yield* execute(executor, workspace, triageItem);

      const ledger = yield* RunLedger.RunLedger;
      const [run] = yield* ledger.listRuns(10);
      assert.strictEqual(run?.status, "exhausted");
      assert.strictEqual(run?.eventCount, 1);
      assert.strictEqual(
        run ? (yield* ledger.events(run.id).pipe(Stream.runCollect)).at(-1)?.type : null,
        "RUN_FINISHED",
      );
    }).pipe(
      Effect.provide(provide([runner([{ type: "CUSTOM", content: 1n } satisfies AgUiEvent, finished])])),
    ),
  );

  it.effect("settles a run when its deferred terminal event cannot be encoded", () =>
    Effect.gen(function* () {
      const executor = yield* Executor.Executor;
      yield* execute(executor, workspace, triageItem);

      const ledger = yield* RunLedger.RunLedger;
      const [run] = yield* ledger.listRuns(10);
      assert.strictEqual(run?.status, "exhausted");
      assert.strictEqual(run?.eventCount, successEvents.length);
      assert.strictEqual(
        run ? (yield* ledger.events(run.id).pipe(Stream.runCollect)).at(-1)?.type : null,
        "RUN_FINISHED",
      );
    }).pipe(
      Effect.provide(
        provide([
          runner(
            successEvents.map((event) => (event.type === "RUN_FINISHED" ? { ...event, content: 1n } : event)),
          ),
        ]),
      ),
    ),
  );

  it.effect("retries a triage run that emits more than one structured result", () => {
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

    return Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const executor = yield* Executor.Executor;
      yield* execute(executor, workspace, triageItem);
      const log = yield* Ref.get(calls);
      assert.isFalse(log.some((call) => call.method === "triaged"));
      assert.include(log.find((call) => call.method === "attemptFailed")?.reason ?? "", "received 2");
    }).pipe(Effect.provide(provide([runner(duplicate)])));
  });

  it.effect("retries malformed Cursor output without coercing proposal prose into a role", () => {
    const malformed: ReadonlyArray<AgUiEvent> = [
      text("## Triage proposal\n\n**Disposition:** ready-for-agent"),
      structuredComplete(
        { _tag: "triage", role: "banana", proposal: "Looks ready from the prose." },
        '{"_tag":"triage","role":"banana","proposal":"Looks ready from the prose."}',
      ),
      finished,
    ];

    return Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const executor = yield* Executor.Executor;
      yield* execute(executor, workspace, triageItem);
      const log = yield* Ref.get(calls);
      assert.isFalse(log.some((call) => call.method === "triaged"));
      assert.include(log.find((call) => call.method === "attemptFailed")?.reason ?? "", "structured");
    }).pipe(Effect.provide(provide([runner(malformed)])));
  });

  it.effect("retries a structured completion envelope without raw output", () => {
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

    return Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const executor = yield* Executor.Executor;
      yield* execute(executor, workspace, triageItem);
      const log = yield* Ref.get(calls);
      assert.isFalse(log.some((call) => call.method === "triaged"));
      assert.include(log.find((call) => call.method === "attemptFailed")?.reason ?? "", "structured");

      const ledger = yield* RunLedger.RunLedger;
      const runs = yield* ledger.listRuns(10);
      const events = runs[0] ? yield* ledger.events(runs[0].id).pipe(Stream.runCollect) : [];
      assert.include(events.at(-1)?.data ?? "", '"finishReason":"failed"');
    }).pipe(Effect.provide(provide([runner(malformed)])));
  });

  it.effect("marks a non-retryable harness failure as exhausted and hands it to a human", () => {
    const error = new HarnessError({ reason: "launch", retryable: false, message: "no cli" });

    return Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const executor = yield* Executor.Executor;
      yield* execute(executor, workspace, triageItem);

      const log = yield* Ref.get(calls);
      const attempt = log.find((c) => c.method === "attemptFailed");
      assert.strictEqual(attempt?.stage, "triage");
      assert.strictEqual(attempt?.reason, "no cli");
      assert.isTrue(attempt?.terminal);
      const handOff = log.find((c) => c.method === "handOff");
      assert.isDefined(handOff);
      assert.include(handOff?.note ?? "", "non-retryable failure");
      assert.include(handOff?.note ?? "", "no cli");

      const ledger = yield* RunLedger.RunLedger;
      const runs = yield* ledger.listRuns(10);
      assert.strictEqual(runs[0]?.status, "exhausted");
    }).pipe(Effect.provide(provide([failingRunner(error)])));
  });

  it.effect("requests a readiness refresh after a Harness launch failure", () => {
    const error = new HarnessError({ reason: "launch", retryable: false, message: "no cli" });

    return Effect.gen(function* () {
      const requests = yield* HarnessReadinessRequests;
      const executor = yield* Executor.Executor;
      yield* execute(executor, workspace, triageItem);

      assert.deepStrictEqual(yield* Ref.get(requests), [cursor]);
    }).pipe(Effect.provide(provideWithHarnessReadiness([failingRunner(error)])));
  });

  it.effect("requests a readiness refresh when Run admission finds expired credentials", () => {
    const error = new HarnessError({ reason: "credential", retryable: false, message: "sign in expired" });

    return Effect.gen(function* () {
      const requests = yield* HarnessReadinessRequests;
      const executor = yield* Executor.Executor;
      yield* execute(executor, workspace, triageItem);

      assert.deepStrictEqual(yield* Ref.get(requests), [cursor]);
    }).pipe(Effect.provide(provideWithHarnessReadiness([preflightFailingRunner(error)])));
  });

  it.effect("requests a readiness refresh when credentials expire during Run preparation", () => {
    const error = new HarnessError({ reason: "credential", retryable: false, message: "sign in expired" });

    return Effect.gen(function* () {
      const requests = yield* HarnessReadinessRequests;
      const executor = yield* Executor.Executor;
      yield* execute(executor, workspace, triageItem);

      assert.deepStrictEqual(yield* Ref.get(requests), [cursor]);
    }).pipe(Effect.provide(provideWithHarnessReadiness([delayedPreflightFailureRunner(error)])));
  });

  it.effect("records a retryable failure as an attempt without a handoff note", () => {
    const error = new HarnessError({ reason: "turn", retryable: true, message: "network blip" });

    return Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const executor = yield* Executor.Executor;
      yield* execute(executor, workspace, triageItem);

      const log = yield* Ref.get(calls);
      const attempt = log.find((c) => c.method === "attemptFailed");
      assert.strictEqual(attempt?.stage, "triage");
      assert.strictEqual(attempt?.reason, "network blip");
      assert.isFalse(attempt?.terminal);
      assert.isFalse(log.some((c) => c.method === "handOff"));

      const ledger = yield* RunLedger.RunLedger;
      const runs = yield* ledger.listRuns(10);
      assert.strictEqual(runs[0]?.status, "failed");
    }).pipe(Effect.provide(provide([failingRunner(error)])));
  });

  it.effect("settles a silent harness run as a retryable failure after its profile budget", () => {
    const silentRunner: TestRunner = {
      make: () => ({
        ...testRunnerDefaults,
        name: cursor,
        sessionKind: "opaque-handle",
        projectedMembers: [],
        planMiddleware: [],
        execution: fullHarnessExecution,
        run: () => Stream.never,
      }),
    };
    return Effect.gen(function* () {
      const executor = yield* Executor.Executor;
      const execution = yield* Effect.forkChild(execute(executor, implementWorkspace, implementItem));
      yield* TestClock.adjust(defaultRunBudget("full"));
      assert.isTrue(yield* Fiber.join(execution));

      const ledger = yield* RunLedger.RunLedger;
      const [run] = yield* ledger.listRuns(10);
      assert.strictEqual(run?.status, "failed");
      const events = run ? yield* ledger.events(run.id).pipe(Stream.runCollect) : [];
      assert.isTrue(events.some((event) => event.type === "RUN_FINISHED"));
    }).pipe(Effect.provide(provide([silentRunner])));
  });

  it.effect("persists a terminal event on failure so watchers flush the run", () => {
    const error = new HarnessError({ reason: "turn", retryable: true, message: "network blip" });

    return Effect.gen(function* () {
      const executor = yield* Executor.Executor;
      yield* execute(executor, workspace, triageItem);

      const ledger = yield* RunLedger.RunLedger;
      const runs = yield* ledger.listRuns(10);
      const id = runs[0]?.id;
      const events = id ? yield* ledger.events(id).pipe(Stream.runCollect) : [];
      assert.isTrue(events.some((event) => event.type === "RUN_FINISHED"));
    }).pipe(Effect.provide(provide([failingRunner(error)])));
  });

  it.effect("exhausts a retryable failure once its attempt reaches the cap", () => {
    const error = new HarnessError({ reason: "turn", retryable: true, message: "network blip" });
    const atCap = { ...triageItem, priorFailures: 2 };

    return Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const executor = yield* Executor.Executor;
      yield* execute(executor, workspace, atCap);

      const log = yield* Ref.get(calls);
      const attempt = log.find((c) => c.method === "attemptFailed");
      assert.strictEqual(attempt?.stage, "triage");
      assert.isTrue(attempt?.terminal);
      const handOff = log.find((c) => c.method === "handOff");
      assert.isDefined(handOff);
      assert.include(handOff?.note ?? "", "3 failed triage attempts");

      const ledger = yield* RunLedger.RunLedger;
      const runs = yield* ledger.listRuns(10);
      assert.strictEqual(runs[0]?.status, "exhausted");
    }).pipe(Effect.provide(provide([failingRunner(error)])));
  });

  it.effect("declines an unregistered harness before claiming or recording a run", () => {
    return Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const executor = yield* Executor.Executor;
      const accepted = yield* execute(executor, workspace, triageItem);

      assert.isFalse(accepted);
      assert.deepStrictEqual(yield* Ref.get(calls), []);
      const ledger = yield* RunLedger.RunLedger;
      assert.strictEqual((yield* ledger.listRuns(10)).length, 0);
    }).pipe(Effect.provide(provide([])));
  });

  it.effect("declines an unsupported harness posture before claiming or recording a run", () => {
    const unsupported = runner(successEvents, { ...fullHarnessExecution, profiles: [] });

    return Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const executor = yield* Executor.Executor;
      const accepted = yield* execute(executor, workspace, triageItem);

      assert.isFalse(accepted);
      assert.deepStrictEqual(yield* Ref.get(calls), []);
      const ledger = yield* RunLedger.RunLedger;
      assert.strictEqual((yield* ledger.listRuns(10)).length, 0);
    }).pipe(Effect.provide(provide([unsupported])));
  });

  it.effect("refuses a saved permission profile the Harness does not declare", () => {
    const readOnlyRunner = runner(implementEvents, {
      ...fullHarnessExecution,
      profiles: ["read-only"],
    });
    const permissionProfile: OperationSettingRow = {
      setting: "permission-profile",
      level: { _tag: "Operation", workflow: "coding", operation: "implement" },
      scope: { _tag: "PrivateWorkspaceOverlay", workspace: workspace.config.name },
      value: "full",
    };

    return Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const executor = yield* Executor.Executor;
      assert.isFalse(yield* execute(executor, implementWorkspace, implementItem));
      assert.deepStrictEqual(yield* Ref.get(calls), []);
      const ledger = yield* RunLedger.RunLedger;
      assert.strictEqual((yield* ledger.listRuns(10)).length, 0);
    }).pipe(
      Effect.provide(
        provide([readOnlyRunner], worktreeStubLayer, noopProviderLayer, trackerRecorder(), [
          ...runnableStages,
          permissionProfile,
        ]),
      ),
    );
  });

  it.effect("assembles the Plan from settings refreshed inside the write gate", () => {
    const refreshedModel: OperationSettingRow = {
      setting: "model",
      level: { _tag: "Operation", workflow: "coding", operation: "implement" },
      scope: { _tag: "PrivateWorkspaceOverlay", workspace: implementWorkspace.config.name },
      value: "refreshed-model",
    };
    const refreshedStore = changingControlStoreLayer(runnableStages, [...runnableStages, refreshedModel]);

    return Effect.gen(function* () {
      const requests = yield* HarnessRequests;
      const assemblyRequests = yield* ContextAssemblyRequests;
      const executor = yield* Executor.Executor;
      yield* execute(executor, implementWorkspace, implementItem);

      const [assemblyRequest] = yield* Ref.get(assemblyRequests);
      assert.strictEqual(assemblyRequest?.workspace, implementWorkspace.config.name);
      assert.deepStrictEqual(assemblyRequest?.operatingInstructions, {
        instructionPackage: "implement-agent",
        instruction: "",
        questions: [],
        hints: [],
      });
      const [request] = yield* Ref.get(requests);
      assert.strictEqual(request?.plan.harness.model, "refreshed-model");
      const model = request?.plan.provenance.resolution.find(({ key }) => key === "model");
      assert.strictEqual(model?.winner?.value, "refreshed-model");
    }).pipe(
      Effect.provide(
        provide(
          [capturingRunner(implementEvents)],
          worktreeStubLayer,
          noopProviderLayer,
          trackerRecorder(),
          runnableStages,
          ContextCleanupCalls.contextAssemblerLayer,
          pluginManagerStub,
          [],
          refreshedStore,
        ),
      ),
    );
  });

  it.effect("leaves the Control store write gate available during worktree preparation", () => {
    return Effect.gen(function* () {
      const controlStore = yield* ControlStore;
      const { entered, release } = yield* WorktreeProbe;
      const executor = yield* Executor.Executor;
      const running = yield* Effect.forkChild(execute(executor, implementWorkspace, implementItem));

      yield* Deferred.await(entered);
      const writer = yield* Effect.forkChild(controlStore.withWrite(Effect.succeed("written")));
      yield* Effect.yieldNow;
      assert.isDefined(writer.pollUnsafe());

      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(running);
    }).pipe(Effect.provide(provide([runner(implementEvents)], blockedPrepareWorktree)), Effect.scoped);
  });

  it.effect("leaves the Control store write gate available during Harness preflight", () => {
    return Effect.gen(function* () {
      const controlStore = yield* ControlStore;
      const gate = yield* HarnessGate;
      const observation = yield* HarnessObservation;
      const executor = yield* Executor.Executor;
      const running = yield* Effect.forkChild(execute(executor, implementWorkspace, implementItem));

      yield* Deferred.await(observation.preflightEntered);
      const writer = yield* Effect.forkChild(controlStore.withWrite(Effect.succeed("written")));
      yield* Effect.yieldNow;
      assert.isDefined(writer.pollUnsafe());

      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(running);
    }).pipe(
      Effect.provide(
        provide(
          [blockedPreflightRunner],
          worktreeStubLayer,
          noopProviderLayer,
          trackerRecorder(),
          runnableStages,
        ),
      ),
      Effect.scoped,
    );
  });

  it.effect("accepts a Run while holding the Control store write gate", () => {
    const writeActive = Ref.makeUnsafe(false);

    return Effect.gen(function* () {
      const executor = yield* Executor.Executor;
      assert.isTrue(yield* execute(executor, implementWorkspace, implementItem));
    }).pipe(
      Effect.provide(
        provide(
          [runner(implementEvents)],
          worktreeStubLayer,
          noopProviderLayer,
          trackerRecorder(),
          runnableStages,
          ContextCleanupCalls.contextAssemblerLayer,
          pluginManagerStub,
          [],
          observedWriteGateControlStoreLayer(writeActive),
          assertRunAcceptanceInsideWriteGate(writeActive),
        ),
      ),
    );
  });

  it.effect("claims an item while holding the Control store write gate", () => {
    const writeActive = Ref.makeUnsafe(false);

    return Effect.gen(function* () {
      const executor = yield* Executor.Executor;
      assert.isTrue(yield* execute(executor, implementWorkspace, implementItem));
    }).pipe(
      Effect.provide(
        provide(
          [runner(implementEvents)],
          worktreeStubLayer,
          noopProviderLayer,
          trackerRecorder(undefined, writeActive),
          runnableStages,
          ContextCleanupCalls.contextAssemblerLayer,
          pluginManagerStub,
          [],
          observedWriteGateControlStoreLayer(writeActive),
        ),
      ),
    );
  });

  it.effect("uses refreshed contribution settings before preparing MCP credentials", () => {
    const enabled: ContributionSettingRow = {
      contribution: { id: "plugin:linear/mcp/linear", kind: "mcp-server" },
      scope: { _tag: "PrivateWorkspaceOverlay", workspace: implementWorkspace.config.name },
      enabled: true,
    };
    const disabled = { ...enabled, enabled: false };
    const refreshedStore = changingControlStoreLayer(runnableStages, runnableStages, [enabled], [disabled]);

    return Effect.gen(function* () {
      const requests = yield* HarnessRequests;
      const executor = yield* Executor.Executor;
      assert.isTrue(yield* execute(executor, implementWorkspace, implementItem));

      const [request] = yield* Ref.get(requests);
      assert.deepStrictEqual(request ? [...resolvedMcpSkills(request)] : [], []);
    }).pipe(
      Effect.provide(
        provide(
          [capturingRunner(implementEvents)],
          worktreeStubLayer,
          noopProviderLayer,
          trackerRecorder(),
          runnableStages,
          ContextCleanupCalls.contextAssemblerLayer,
          missingPluginCredentialLayer,
          [],
          refreshedStore,
        ),
      ),
    );
  });

  it.effect("records no run when claiming fails before execution starts", () => {
    const failure = new IssueTrackerError({
      reason: "unavailable",
      message: "coordination marker write failed",
    });

    return Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const executor = yield* Executor.Executor;
      const accepted = yield* execute(executor, workspace, triageItem);

      assert.isFalse(accepted);
      assert.deepStrictEqual(yield* Ref.get(calls), [{ method: "claim", item: triageItem.id }]);
      const ledger = yield* RunLedger.RunLedger;
      assert.deepStrictEqual(yield* ledger.listRuns(10), []);
    }).pipe(
      Effect.provide(
        provide([runner(successEvents)], worktreeStubLayer, noopProviderLayer, trackerRecorder(failure)),
      ),
    );
  });

  it.effect("stops re-attempting a refused claim on every following generation", () => {
    const failure = new IssueTrackerError({
      reason: "unavailable",
      message: 'Linear refused creating the "cogwork:claimed" label in team REC',
    });

    return Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const executor = yield* Executor.Executor;

      assert.isFalse(yield* execute(executor, workspace, triageItem));
      assert.isFalse(yield* execute(executor, workspace, triageItem));
      assert.isFalse(yield* execute(executor, workspace, triageItem));

      assert.deepStrictEqual(yield* Ref.get(calls), [{ method: "claim", item: triageItem.id }]);
    }).pipe(
      Effect.provide(
        provide([runner(successEvents)], worktreeStubLayer, noopProviderLayer, trackerRecorder(failure)),
      ),
    );
  });

  it.effect("retries a refused claim once its hold-off window expires", () => {
    const failure = new IssueTrackerError({
      reason: "unavailable",
      message: 'Linear refused creating the "cogwork:claimed" label in team REC',
    });

    return Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const executor = yield* Executor.Executor;

      assert.isFalse(yield* execute(executor, workspace, triageItem));
      yield* TestClock.adjust("2 minutes");
      assert.isFalse(yield* execute(executor, workspace, triageItem));

      assert.deepStrictEqual(yield* Ref.get(calls), [
        { method: "claim", item: triageItem.id },
        { method: "claim", item: triageItem.id },
      ]);
    }).pipe(
      Effect.provide(
        provide([runner(successEvents)], worktreeStubLayer, noopProviderLayer, trackerRecorder(failure)),
      ),
    );
  });

  it.effect("parks an item the work source will never let it claim, with the refusal", () => {
    const failure = new IssueTrackerError({
      reason: "unavailable",
      retryable: false,
      message: 'Linear refused creating the "cogwork:claimed" label in team REC: not allowed',
    });

    return Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const executor = yield* Executor.Executor;

      assert.isFalse(yield* execute(executor, workspace, triageItem));

      const written = yield* Ref.get(calls);
      assert.deepStrictEqual(
        written.map((call) => call.method),
        ["claim", "note", "handOff"],
      );
      const note = written.find((call) => call.method === "note")?.note ?? "";
      assert.include(note, "Could not claim this issue for triage");
      assert.include(note, "cogwork:claimed");
      assert.include(note, "Add the label named below");
      assert.include(note, "ready-for-human");
      assert.strictEqual(written.find((call) => call.method === "handOff")?.stage, "triage");
    }).pipe(
      Effect.provide(
        provide([runner(successEvents)], worktreeStubLayer, noopProviderLayer, trackerRecorder(failure)),
      ),
    );
  });

  it.effect("leaves a claim the work source may yet accept unparked", () => {
    const failure = new IssueTrackerError({
      reason: "unavailable",
      message: "coordination marker write failed",
    });

    return Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const executor = yield* Executor.Executor;

      assert.isFalse(yield* execute(executor, workspace, triageItem));
      assert.deepStrictEqual(yield* Ref.get(calls), [{ method: "claim", item: triageItem.id }]);
    }).pipe(
      Effect.provide(
        provide([runner(successEvents)], worktreeStubLayer, noopProviderLayer, trackerRecorder(failure)),
      ),
    );
  });

  it.effect("does nothing when triage is disabled in the Operation Definition", () => {
    return Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const executor = yield* Executor.Executor;
      assert.isFalse(yield* execute(executor, disabledWorkspace, triageItem));
      assert.deepStrictEqual(yield* Ref.get(calls), []);

      const ledger = yield* RunLedger.RunLedger;
      assert.deepStrictEqual(yield* ledger.listRuns(10), []);
    }).pipe(
      Effect.provide(
        provide([runner(successEvents)], worktreeStubLayer, noopProviderLayer, trackerRecorder(), []),
      ),
    );
  });

  it.effect("releases an interrupted claim when its operation is now disabled", () => {
    const resumed: EligibleWork = {
      ...triageItem,
      resume: { session: previousSession, reason: "interrupted" },
    };

    return Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const executor = yield* Executor.Executor;
      assert.isFalse(yield* execute(executor, disabledWorkspace, resumed));
      assert.deepStrictEqual(
        (yield* Ref.get(calls)).map((call) => call.method),
        ["note", "release"],
      );
    }).pipe(
      Effect.provide(
        provide([runner(successEvents)], worktreeStubLayer, noopProviderLayer, trackerRecorder(), []),
      ),
    );
  });

  it.effect("releases a sessionless interrupted claim when its operation is now disabled", () => {
    const recovered: EligibleWork = {
      ...triageItem,
      recovery: "interrupted",
    };

    return Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const executor = yield* Executor.Executor;
      assert.isFalse(yield* execute(executor, disabledWorkspace, recovered));
      assert.deepStrictEqual(
        (yield* Ref.get(calls)).map((call) => call.method),
        ["note", "release"],
      );
    }).pipe(
      Effect.provide(
        provide([runner(successEvents)], worktreeStubLayer, noopProviderLayer, trackerRecorder(), []),
      ),
    );
  });

  it.effect("runs an implement job in the worktree and ledgers the run keyed by branch", () => {
    return Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const requests = yield* HarnessRequests;
      const executor = yield* Executor.Executor;
      yield* execute(executor, implementWorkspace, implementItem);

      const [request] = yield* Ref.get(requests);
      assert.strictEqual(request?.plan.sandbox.workspace, `/wt/${implementBranch}`);
      assert.strictEqual(request?.plan.harness.profile, "full");
      assert.include(request?.plan.messages[0]?.content ?? "", "implement-agent");
      assert.include(request?.plan.messages[0]?.content ?? "", "#15");
      assert.deepStrictEqual(request ? [...resolvedMcpSkills(request)] : [], []);
      assert.deepStrictEqual(
        request?.plan.skills.map(({ identity, name, source }) => ({ identity, name, source })),
        [
          {
            identity: privateSkill.id,
            name: projectedContributionName(privateSkill.id),
            source: privateSkill.file,
          },
        ],
      );

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
    }).pipe(Effect.provide(provide([capturingRunner(implementEvents)])));
  });

  it.effect("pushes the branch before opening the pull request", () => {
    const order = Ref.makeUnsafe<ReadonlyArray<"open" | "push">>([]);
    const worktree = worktreeDouble(() => ({
      ...worktreeStub,
      pushBranch: () => Ref.update(order, (writes) => [...writes, "push" as const]),
    }));
    const sourceControl = pullRequestProvider({
      beforeOpen: Ref.update(order, (writes) => [...writes, "open" as const]),
    });
    return Effect.gen(function* () {
      const probe = yield* PullRequestCalls;
      const calls = yield* TrackerCalls;
      const executor = yield* Executor.Executor;

      yield* execute(executor, implementWorkspace, implementItem);

      assert.deepStrictEqual(yield* Ref.get(probe.opened), [
        {
          headBranch: implementBranch,
          baseBranch: "main",
          title: "Open pull requests from the engine",
          body: "Closes #15",
        },
      ]);
      assert.deepStrictEqual(yield* Ref.get(order), ["push", "open"]);
      const log = yield* Ref.get(calls);
      assert.isTrue(log.some((call) => call.method === "implemented"));
      assert.isTrue(log.some((call) => call.method === "release"));
      const [run] = yield* (yield* RunLedger.RunLedger).listRuns(1);
      assert.strictEqual(run?.status, "succeeded");
    }).pipe(
      Effect.provide(
        provide([runner(readyForPrEvents)], worktree, sourceControl).pipe(
          Layer.provideMerge(PullRequestCalls.layer),
        ),
      ),
    );
  });

  it.effect("opens the pull request after its prepared worktree disappears", () =>
    Effect.gen(function* () {
      const probe = yield* PullRequestCalls;
      const calls = yield* TrackerCalls;
      const executor = yield* Executor.Executor;

      yield* execute(executor, implementWorkspace, implementItem);

      assert.deepStrictEqual(yield* Ref.get(probe.opened), [
        {
          headBranch: implementBranch,
          baseBranch: "main",
          title: "Open pull requests from the engine",
          body: "Closes #15",
        },
      ]);
      const log = yield* Ref.get(calls);
      assert.isTrue(log.some((call) => call.method === "implemented"));
      assert.isTrue(log.some((call) => call.method === "release"));
      const [run] = yield* (yield* RunLedger.RunLedger).listRuns(1);
      assert.strictEqual(run?.status, "succeeded");
    }).pipe(
      Effect.provide(
        provide([runner(readyForPrEvents)], preparedWorktreeRemoved, pullRequestProvider()).pipe(
          Layer.provideMerge(PullRequestCalls.layer),
        ),
      ),
    ),
  );

  it.effect("settles and releases the Run when pull request creation fails", () =>
    Effect.gen(function* () {
      const probe = yield* PullRequestCalls;
      const calls = yield* TrackerCalls;
      const executor = yield* Executor.Executor;

      yield* execute(executor, implementWorkspace, implementItem);

      assert.lengthOf(yield* Ref.get(probe.opened), 1);
      const log = yield* Ref.get(calls);
      assert.isFalse(log.some((call) => call.method === "implemented"));
      assert.isFalse(log.some((call) => call.method === "attemptFailed"));
      assert.isTrue(log.some((call) => call.method === "release"));
      const [run] = yield* (yield* RunLedger.RunLedger).listRuns(1);
      assert.strictEqual(run?.status, "failed");
    }).pipe(
      Effect.provide(
        provide(
          [runner(readyForPrEvents)],
          worktreeStubLayer,
          pullRequestProvider({
            openError: new IssueTrackerError({
              reason: "unavailable",
              message: "pull request endpoint unavailable",
            }),
          }),
          trackerRecorder(),
        ).pipe(Layer.provideMerge(PullRequestCalls.layer)),
      ),
    ),
  );

  it.effect("settles a push failure as a write failure without failing the attempt", () => {
    const failure = new GitError({
      command: "push",
      message: "remote unavailable",
      reason: "timeout",
      retryable: true,
    });
    return Effect.gen(function* () {
      const probe = yield* PullRequestCalls;
      const calls = yield* TrackerCalls;
      const executor = yield* Executor.Executor;

      yield* execute(executor, implementWorkspace, implementItem);

      assert.deepStrictEqual(yield* Ref.get(probe.opened), []);
      const log = yield* Ref.get(calls);
      assert.isFalse(log.some((call) => call.method === "implemented"));
      assert.isFalse(log.some((call) => call.method === "attemptFailed"));
      assert.isTrue(log.some((call) => call.method === "release"));
      const [run] = yield* (yield* RunLedger.RunLedger).listRuns(1);
      assert.strictEqual(run?.status, "failed");
    }).pipe(
      Effect.provide(
        provide([runner(readyForPrEvents)], failedPushWorktree(failure), pullRequestProvider()).pipe(
          Layer.provideMerge(PullRequestCalls.layer),
        ),
      ),
    );
  });

  it.effect("records and releases a retryable failure when the git gate fails", () => {
    const failure = new GitError({
      command: "fetch origin",
      message: "git fetch origin timed out",
      reason: "timeout",
      retryable: true,
    });
    return Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const executor = yield* Executor.Executor;

      yield* execute(executor, implementWorkspace, implementItem);

      const log = yield* Ref.get(calls);
      assert.strictEqual(
        log.find((call) => call.method === "attemptFailed")?.reason,
        "git fetch origin: git fetch origin timed out",
      );
      assert.isTrue(log.some((call) => call.method === "release"));
      assert.isFalse(log.some((call) => call.method === "handOff"));
      const [run] = yield* (yield* RunLedger.RunLedger).listRuns(1);
      assert.strictEqual(run?.status, "failed");
    }).pipe(
      Effect.provide(
        provide(
          [runner(readyForPrEvents)],
          failedPullRequestReadinessWorktree(failure),
          pullRequestProvider(),
        ).pipe(Layer.provideMerge(PullRequestCalls.layer)),
      ),
    );
  });

  it.effect("settles a pull request lookup write failure without failing the attempt", () => {
    const failure = new IssueTrackerError({
      reason: "unavailable",
      message: "pull request lookup unavailable",
    });
    return Effect.gen(function* () {
      const probe = yield* PullRequestCalls;
      const worktree = yield* WorktreeProbe;
      const calls = yield* TrackerCalls;
      const executor = yield* Executor.Executor;

      yield* execute(executor, implementWorkspace, implementItem);

      assert.strictEqual(yield* Ref.get(probe.observations), 1);
      assert.deepStrictEqual(yield* Ref.get(probe.opened), []);
      assert.deepStrictEqual(yield* Ref.get(worktree.pushes), [implementBranch]);
      const log = yield* Ref.get(calls);
      assert.isFalse(log.some((call) => call.method === "attemptFailed"));
      assert.isTrue(log.some((call) => call.method === "release"));
      const [run] = yield* (yield* RunLedger.RunLedger).listRuns(1);
      assert.strictEqual(run?.status, "failed");
    }).pipe(
      Effect.provide(
        provide(
          [runner(readyForPrEvents)],
          worktreeStubLayer,
          pullRequestProvider({ findError: failure }),
        ).pipe(Layer.provideMerge(PullRequestCalls.layer)),
      ),
    );
  });

  it.effect("records replay output without applying its structured outcome", () => {
    return Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const executor = yield* Executor.Executor;
      yield* execute(executor, implementWorkspace, implementItem);

      const log = yield* Ref.get(calls);
      assert.isFalse(log.some((call) => call.method === "implemented"));
      assert.isFalse(log.some((call) => call.method === "attemptFailed"));

      const ledger = yield* RunLedger.RunLedger;
      const [run] = yield* ledger.listRuns(10);
      assert.strictEqual(run?.status, "succeeded");
      assert.strictEqual(run?.eventCount, implementEvents.length);
    }).pipe(Effect.provide(provideReplay([recordOnlyRunner(implementEvents)])));
  });

  it.effect("records deterministic counts across eight concurrent replays", () => {
    return Effect.gen(function* () {
      const items = Array.from({ length: 8 }, (_, index) => {
        const workItem = id(`#${100 + index}`);
        return {
          ...implementItem,
          id: workItem,
          title: `Replay ${index + 1}`,
          workContext: workContext(workItem),
        };
      });
      const bus = yield* DaemonEventBus.DaemonEventBus;
      const subscription = yield* bus.subscribe();
      const expectedEvents = items.length * implementEvents.length;
      const recordedActivities = yield* DaemonEventBus.runActivityStream(
        Stream.fromSubscription(subscription),
      ).pipe(Stream.take(expectedEvents), Stream.runCount, Effect.forkChild({ startImmediately: true }));
      const executor = yield* Executor.Executor;

      const accepted = yield* Effect.forEach(items, (item) => execute(executor, implementWorkspace, item), {
        concurrency: "unbounded",
      });
      const ledger = yield* RunLedger.RunLedger;
      const runs = yield* ledger.listRuns(items.length);

      assert.deepStrictEqual(
        accepted,
        items.map(() => true),
      );
      assert.strictEqual(yield* Fiber.join(recordedActivities), expectedEvents);
      assert.strictEqual(runs.length, items.length);
      assert.isTrue(runs.every((run) => run.eventCount === implementEvents.length));
      assert.isTrue(runs.every((run) => run.status === "succeeded"));
    }).pipe(Effect.provide(provideReplay([recordOnlyRunner(implementEvents)])));
  });

  it.effect("mints globally unique Run IDs across Executor lifetimes", () =>
    Effect.gen(function* () {
      const firstExecutor = yield* Executor.make;
      yield* execute(firstExecutor, implementWorkspace, implementItem);
      const secondWorkItem = id("#155-run-id");
      const secondExecutor = yield* Executor.make;
      yield* execute(secondExecutor, implementWorkspace, {
        ...implementItem,
        id: secondWorkItem,
        workContext: workContext(secondWorkItem),
      });

      const [second, first] = yield* (yield* RunLedger.RunLedger).listRuns(2);
      assert.isDefined(first);
      assert.isDefined(second);
      assert.notStrictEqual(first.id, second.id);
    }).pipe(Effect.provide(Layer.merge(provide([runner(implementEvents)]), Availability.Availability.layer))),
  );

  it.effect("correlates claimed-run library logs and spans", () => {
    return Effect.gen(function* () {
      const observation = yield* HarnessObservation;
      const logger = Logger.make<unknown, void>(({ fiber, message }) => {
        observation.logs.push({
          message,
          annotations: { ...fiber.getRef(References.CurrentLogAnnotations) },
        });
      });
      const executor = yield* Executor.Executor;
      yield* execute(executor, implementWorkspace, implementItem).pipe(Effect.withLogger(logger));

      const ledger = yield* RunLedger.RunLedger;
      const [run] = yield* ledger.listRuns(1);
      assert.isDefined(run);
      const correlation = {
        workspace: "gh",
        item: "#15",
        stage: "implement",
        runId: run.id,
      };
      const libraryLog = observation.logs.find(({ message }) =>
        Array.isArray(message) ? message.includes("library log") : message === "library log",
      );
      assert.deepStrictEqual(libraryLog?.annotations, correlation);
      assert.deepStrictEqual(libraryLog?.message, ["library log", { session: "sess-42" }]);

      const librarySpan = yield* Ref.get(observation.span);
      assert.isNotNull(librarySpan);
      assert.deepStrictEqual(Object.fromEntries(librarySpan.attributes), correlation);
    }).pipe(Effect.provide(provide([observingRunner])));
  });

  it.effect("releases runner resources when the run ends", () =>
    Effect.gen(function* () {
      const observation = yield* HarnessObservation;
      const executor = yield* Executor.Executor;
      yield* execute(executor, implementWorkspace, implementItem);
      assert.isTrue(yield* Ref.get(observation.released));
    }).pipe(Effect.provide(provide([resourceRunner]))),
  );

  it.effect("logs cleanup failures without repeating claimed-run annotations", () => {
    return Effect.gen(function* () {
      const observation = yield* HarnessObservation;
      const logger = Logger.make<unknown, void>(({ fiber, message }) => {
        observation.logs.push({
          message,
          annotations: { ...fiber.getRef(References.CurrentLogAnnotations) },
        });
      });
      const executor = yield* Executor.Executor;
      yield* execute(executor, implementWorkspace, implementItem).pipe(Effect.withLogger(logger));

      const ledger = yield* RunLedger.RunLedger;
      const [run] = yield* ledger.listRuns(1);
      const cleanupLog = observation.logs.find(({ message }) =>
        Array.isArray(message) ? message.includes("run context cleanup failed") : false,
      );
      assert.deepStrictEqual(cleanupLog?.annotations, {
        workspace: "gh",
        item: "#15",
        stage: "implement",
        runId: run?.id,
      });
      assert.deepStrictEqual(cleanupLog?.message, [
        "run context cleanup failed",
        { message: "cleanup failed" },
      ]);
    }).pipe(
      Effect.provide(
        provide(
          [runner(implementEvents)],
          worktreeStubLayer,
          noopProviderLayer,
          trackerRecorder(),
          runnableStages,
          failingCleanupContext,
        ),
      ),
    );
  });

  it.effect("records and releases a pull request gate decline", () =>
    Effect.gen(function* () {
      const probe = yield* PullRequestCalls;
      const calls = yield* TrackerCalls;
      const executor = yield* Executor.Executor;

      yield* execute(executor, implementWorkspace, implementItem);

      assert.strictEqual(yield* Ref.get(probe.observations), 0);
      assert.deepStrictEqual(yield* Ref.get(probe.opened), []);
      const log = yield* Ref.get(calls);
      assert.isFalse(log.some((call) => call.method === "implemented"));
      assert.isTrue(log.some((call) => call.method === "release"));
      assert.strictEqual(
        log.find((call) => call.method === "attemptFailed")?.reason,
        "head has not been pushed to origin",
      );
      assert.isFalse(log.some((call) => call.method === "note"));
      const [run] = yield* (yield* RunLedger.RunLedger).listRuns(1);
      assert.strictEqual(run?.status, "declined");
    }).pipe(
      Effect.provide(
        provide(
          [runner(readyForPrEvents)],
          declinedPullRequestWorktree("head has not been pushed to origin"),
          pullRequestProvider({ existingHead: implementBranch }),
        ).pipe(Layer.provideMerge(PullRequestCalls.layer)),
      ),
    ),
  );

  it.effect("settles the Run when recording a pull request gate decline fails", () => {
    const failure = new IssueTrackerError({ reason: "unavailable", message: "tracker unavailable" });
    return Effect.gen(function* () {
      const executor = yield* Executor.Executor;

      const error = yield* Effect.flip(execute(executor, implementWorkspace, implementItem));

      assert.strictEqual(error, failure);
      const [run] = yield* (yield* RunLedger.RunLedger).listRuns(1);
      assert.strictEqual(run?.status, "failed");
    }).pipe(
      Effect.provide(
        provide(
          [runner(readyForPrEvents)],
          declinedPullRequestWorktree("head is not ahead of origin/main"),
          pullRequestProvider(),
          trackerRecorder(undefined, undefined, failure),
        ).pipe(Layer.provideMerge(PullRequestCalls.layer)),
      ),
    );
  });

  it.effect("hands off a pull request gate decline after the retry budget is spent", () =>
    Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const executor = yield* Executor.Executor;

      yield* execute(executor, implementWorkspace, { ...implementItem, priorFailures: 2 });

      const log = yield* Ref.get(calls);
      assert.isTrue(log.some((call) => call.method === "attemptFailed"));
      assert.isTrue(log.some((call) => call.method === "handOff"));
      assert.isTrue(log.some((call) => call.method === "release"));
      const [run] = yield* (yield* RunLedger.RunLedger).listRuns(1);
      assert.strictEqual(run?.status, "declined");
    }).pipe(
      Effect.provide(
        provide(
          [runner(readyForPrEvents)],
          declinedPullRequestWorktree("head is not ahead of origin/main"),
          pullRequestProvider(),
        ).pipe(Layer.provideMerge(PullRequestCalls.layer)),
      ),
    ),
  );

  it.effect("pushes before settling when an open pull request already exists", () =>
    Effect.gen(function* () {
      const probe = yield* PullRequestCalls;
      const worktree = yield* WorktreeProbe;
      const calls = yield* TrackerCalls;
      const executor = yield* Executor.Executor;

      yield* execute(executor, implementWorkspace, implementItem);

      assert.strictEqual(yield* Ref.get(probe.observations), 1);
      assert.deepStrictEqual(yield* Ref.get(probe.opened), []);
      assert.deepStrictEqual(yield* Ref.get(worktree.pushes), [implementBranch]);
      const log = yield* Ref.get(calls);
      assert.isTrue(log.some((call) => call.method === "implemented"));
      assert.isTrue(log.some((call) => call.method === "release"));
      assert.isFalse(log.some((call) => call.method === "attemptFailed"));
      assert.isFalse(log.some((call) => call.method === "note"));
      const [run] = yield* (yield* RunLedger.RunLedger).listRuns(1);
      assert.strictEqual(run?.status, "succeeded");
    }).pipe(
      Effect.provide(
        provide(
          [runner(readyForPrEvents)],
          worktreeStubLayer,
          pullRequestProvider({ existingHead: implementBranch }),
        ).pipe(Layer.provideMerge(PullRequestCalls.layer)),
      ),
    ),
  );

  it.effect("mints an opaque-handle session for a Cursor-served run and captures its handle", () => {
    return Effect.gen(function* () {
      const executor = yield* Executor.Executor;
      yield* execute(executor, implementWorkspace, implementItem);

      const ledger = yield* RunLedger.RunLedger;
      const [run] = yield* ledger.listRuns(10);
      assert.strictEqual(yield* kindOf(ledger, run?.session), "opaque-handle");
      assert.strictEqual(yield* handleOf(ledger, run?.session), "sess-42");
    }).pipe(Effect.provide(provide([runner(implementEvents)])));
  });

  it.effect("mints an owned-transcript session for a provider-served run", () => {
    return Effect.gen(function* () {
      const executor = yield* Executor.Executor;
      yield* execute(executor, implementWorkspace, implementItem);

      const ledger = yield* RunLedger.RunLedger;
      const [run] = yield* ledger.listRuns(10);
      assert.strictEqual(run?.status, "succeeded");
      assert.strictEqual(yield* kindOf(ledger, run?.session), "owned-transcript");
    }).pipe(Effect.provide(provide([ownedTranscriptRunner(implementEvents)])));
  });

  it.effect("hands the workspace's MCP skills to the harness on the run request", () => {
    return Effect.gen(function* () {
      const requests = yield* HarnessRequests;
      const executor = yield* Executor.Executor;
      yield* execute(executor, mcpWorkspace, implementItem);

      const [request] = yield* Ref.get(requests);
      assert.deepStrictEqual(request ? [...resolvedMcpSkills(request)] : [], [
        {
          name: request ? resolvedMcpSkills(request)[0]?.name : undefined,
          endpoint: "https://mcp.linear.app/mcp/readonly",
          bearer: null,
        },
      ]);
    }).pipe(Effect.provide(provide([capturingRunner(implementEvents)])));
  });

  it.effect("records an optional Plugin MCP server with an unavailable credential", () => {
    return Effect.gen(function* () {
      const requests = yield* HarnessRequests;
      const executor = yield* Executor.Executor;
      yield* execute(executor, implementWorkspace, implementItem);

      const [request] = yield* Ref.get(requests);
      assert.deepStrictEqual(request ? [...resolvedMcpSkills(request)] : [], []);
      assert.isTrue(
        request?.plan.instructions.some(({ source }) => source === "/plugins/linear/rules/linear.md"),
      );
      const unavailable = request?.plan.mcp.find(({ identity }) => identity === "plugin:linear/mcp/linear");
      assert.include(
        unavailable && "unavailableReason" in unavailable ? (unavailable.unavailableReason ?? "") : "",
        "environment key",
      );
    }).pipe(
      Effect.provide(
        provide(
          [capturingRunner(implementEvents)],
          worktreeStubLayer,
          noopProviderLayer,
          trackerRecorder(),
          runnableStages,
          contributionContext,
          missingPluginCredentialLayer,
        ),
      ),
    );
  });

  it.effect("projects an installed Plugin MCP server from the accepted Plan", () => {
    return Effect.gen(function* () {
      const requests = yield* HarnessRequests;
      const executor = yield* Executor.Executor;
      yield* execute(executor, implementWorkspace, implementItem);

      const [request] = yield* Ref.get(requests);
      const [skill] = request ? resolvedMcpSkills(request) : [];
      assert.strictEqual(skill?.name, projectedContributionName("plugin:linear/mcp/linear"));
      assert.strictEqual(skill?.endpoint, "https://mcp.linear.app/mcp");
      assert.strictEqual(skill?.bearer ? Redacted.value(skill.bearer) : null, "connection-token");
      assert.deepStrictEqual(
        request?.plan.mcp.filter(({ identity }) => identity === "plugin:linear/mcp/linear").length,
        1,
      );
      assert.deepStrictEqual(
        request?.plan.provenance.stamps.find(({ source }) => source === "plugin:linear"),
        DeclaredVersion.make({ source: "plugin:linear", version: "1.2.3" }),
      );
    }).pipe(
      Effect.provide(
        provide(
          [capturingRunner(implementEvents)],
          worktreeStubLayer,
          noopProviderLayer,
          trackerRecorder(),
          runnableStages,
          ContextCleanupCalls.contextAssemblerLayer,
          availablePluginMcpLayer,
        ),
      ),
    );
  });

  it.effect("omits a Plugin MCP server disabled for the workspace", () => {
    return Effect.gen(function* () {
      const requests = yield* HarnessRequests;
      const executor = yield* Executor.Executor;
      yield* execute(executor, implementWorkspace, implementItem);

      const [request] = yield* Ref.get(requests);
      assert.deepStrictEqual(request ? [...resolvedMcpSkills(request)] : [], []);
      const trace = request?.plan.provenance.resolution.find(
        ({ key }) => key === "contribution:plugin:linear/mcp/linear:enabled",
      );
      assert.strictEqual(trace?.winner?.source, "Private workspace overlay gh");
      assert.strictEqual(trace?.winner?.value, false);
    }).pipe(
      Effect.provide(
        provide(
          [capturingRunner(implementEvents)],
          worktreeStubLayer,
          noopProviderLayer,
          trackerRecorder(),
          runnableStages,
          ContextCleanupCalls.contextAssemblerLayer,
          availablePluginMcpLayer,
          [
            {
              contribution: { id: "plugin:linear/mcp/linear", kind: "mcp-server" },
              scope: { _tag: "PrivateWorkspaceOverlay", workspace: implementWorkspace.config.name },
              enabled: false,
            },
          ],
        ),
      ),
    );
  });

  it.effect("keeps running when Plugin contributions cannot load", () => {
    return Effect.gen(function* () {
      const requests = yield* HarnessRequests;
      const calls = yield* TrackerCalls;
      const executor = yield* Executor.Executor;
      yield* execute(executor, implementWorkspace, implementItem);

      const [request] = yield* Ref.get(requests);
      assert.deepStrictEqual(request ? [...resolvedMcpSkills(request)] : [], []);
      assert.deepStrictEqual(
        request?.plan.skills.map(({ identity }) => identity),
        [privateSkill.id],
      );
      assert.include(
        request?.plan.mcp.find(({ identity }) => identity === "plugin:linear/mcp/linear")
          ?.unavailableReason ?? "",
        "invalid",
      );
      assert.isFalse((yield* Ref.get(calls)).some((call) => call.method === "handOff"));
    }).pipe(
      Effect.provide(
        provide(
          [capturingRunner(implementEvents)],
          worktreeStubLayer,
          noopProviderLayer,
          trackerRecorder(),
          runnableStages,
          ContextCleanupCalls.contextAssemblerLayer,
          unavailablePluginLayer,
        ),
      ),
    );
  });

  it.effect("resolves a credential-store bearer for an authed skill without leaking it to the ledger", () => {
    return Effect.gen(function* () {
      const requests = yield* HarnessRequests;
      const executor = yield* Executor.Executor;
      yield* execute(executor, mcpAuthWorkspace, implementItem);

      const [request] = yield* Ref.get(requests);
      const [skill] = request ? resolvedMcpSkills(request) : [];
      assert.match(skill?.name ?? "", /^engine__/);
      assert.isNotNull(skill?.bearer ?? null);
      assert.strictEqual(skill?.bearer ? Redacted.value(skill.bearer) : null, "token-for-linear");

      const ledger = yield* RunLedger.RunLedger;
      const [run] = yield* ledger.listRuns(10);
      const events = run ? yield* ledger.events(run.id).pipe(Stream.runCollect) : [];
      assert.isFalse(events.some((event) => event.data.includes("token-for-linear")));
    }).pipe(Effect.provide(provide([capturingRunner(implementEvents)])));
  });

  it.effect("ledgers the session while the run is still in flight", () => {
    return Effect.gen(function* () {
      const release = yield* HarnessGate;
      const executor = yield* Executor.Executor;
      const ledger = yield* RunLedger.RunLedger;
      const bus = yield* DaemonEventBus.DaemonEventBus;
      const subscription = yield* bus.subscribe();
      const running = yield* Effect.forkChild(execute(executor, implementWorkspace, implementItem));

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
    }).pipe(Effect.provide(provide([gatedRunner])), Effect.scoped);
  });

  it.effect("lets an accepted Run finish after its Harness is disabled", () => {
    const settings = Ref.makeUnsafe<ReadonlyArray<HarnessEnablement>>([]);

    return Effect.gen(function* () {
      const release = yield* HarnessGate;
      const executor = yield* Executor.Executor;
      const ledger = yield* RunLedger.RunLedger;
      const store = yield* ControlStore;
      const bus = yield* DaemonEventBus.DaemonEventBus;
      const subscription = yield* bus.subscribe();
      const running = yield* Effect.forkChild(execute(executor, implementWorkspace, implementItem));

      yield* DaemonEventBus.runActivityStream(Stream.fromSubscription(subscription)).pipe(
        Stream.filter((item) => item.event.type === "TEXT_MESSAGE_CONTENT"),
        Stream.runHead,
      );
      yield* store.withWrite(store.setHarnessEnabled(cursor, false));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(running);

      const [finished] = yield* ledger.listRuns(10);
      assert.strictEqual(finished?.status, "succeeded");
    }).pipe(
      Effect.provide(
        provide(
          [gatedRunner],
          worktreeStubLayer,
          noopProviderLayer,
          trackerRecorder(),
          runnableStages,
          ContextCleanupCalls.contextAssemblerLayer,
          pluginManagerStub,
          [],
          mutableHarnessControlStoreLayer(settings),
        ),
      ),
      Effect.scoped,
    );
  });

  it.effect("holds the claim when the run is interrupted so recovery can resume it", () => {
    return Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const cleanups = yield* ContextCleanupCalls;
      const executor = yield* Executor.Executor;
      const bus = yield* DaemonEventBus.DaemonEventBus;
      const subscription = yield* bus.subscribe();
      const running = yield* Effect.forkChild(execute(executor, implementWorkspace, implementItem));

      yield* DaemonEventBus.runActivityStream(Stream.fromSubscription(subscription)).pipe(
        Stream.filter((item) => item.event.type === "TEXT_MESSAGE_CONTENT"),
        Stream.runHead,
      );
      yield* Fiber.interrupt(running);

      const log = yield* Ref.get(calls);
      assert.isTrue(log.some((c) => c.method === "claim"));
      assert.isFalse(log.some((c) => c.method === "release"));
      assert.lengthOf(yield* Ref.get(cleanups), 1);
    }).pipe(Effect.provide(provide([gatedRunner])), Effect.scoped);
  });

  it.effect("releases the claim when a crash is combined with an interrupt", () => {
    return Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const executor = yield* Executor.Executor;

      yield* Effect.exit(execute(executor, implementWorkspace, implementItem));

      const log = yield* Ref.get(calls);
      assert.isTrue(log.some((call) => call.method === "claim"));
      assert.lengthOf(
        log.filter((call) => call.method === "release"),
        1,
      );
    }).pipe(
      Effect.provide(
        provide([
          capturingRunner(
            [],
            Stream.failCause(Cause.combine(Cause.die(new Error("harness crashed")), Cause.interrupt())),
          ),
        ]),
      ),
    );
  });

  it.effect("releases the claim after a manual cancellation finishes cleanup", () => {
    return Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const cleanups = yield* ContextCleanupCalls;
      const executor = yield* Executor.Executor;
      const control = yield* RunControl.RunControl;
      const bus = yield* DaemonEventBus.DaemonEventBus;
      const subscription = yield* bus.subscribe();
      const running = yield* Effect.forkChild(execute(executor, implementWorkspace, implementItem));

      yield* DaemonEventBus.runActivityStream(Stream.fromSubscription(subscription)).pipe(
        Stream.filter((item) => item.event.type === "TEXT_MESSAGE_CONTENT"),
        Stream.runHead,
      );

      const ledger = yield* RunLedger.RunLedger;
      const [run] = yield* ledger.listRuns(10);
      assert.isNotNull(run ?? null);
      if (!run) return;

      const cancellation = yield* control.cancel(run.id);
      assert.strictEqual(cancellation._tag, "Interrupting");
      if (cancellation._tag === "Interrupting") yield* cancellation.awaitTermination;
      yield* Fiber.await(running);

      const log = yield* Ref.get(calls);
      assert.isTrue(log.some((call) => call.method === "release"));
      assert.lengthOf(yield* Ref.get(cleanups), 1);
    }).pipe(
      Effect.provide(
        provide(
          [gatedRunner],
          worktreeStubLayer,
          noopProviderLayer,
          trackerRecorder(),
          runnableStages,
          ContextCleanupCalls.contextAssemblerLayer,
          pluginManagerStub,
          [],
          controlStoreLayer(runnableStages, []),
          runLedgerIdentity,
          connectionStoreStub,
          RunControl.layer,
        ),
      ),
      Effect.scoped,
    );
  });

  it.effect("keeps a Run cancellable while it waits for worktree ownership", () => {
    const blocked = cancellationWhileWaitingForOwnership();
    return Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const executor = yield* Executor.Executor;
      const control = yield* RunControl.RunControl;
      const running = yield* Effect.forkChild(execute(executor, implementWorkspace, implementItem));

      yield* Deferred.await(blocked.entered);
      const cancellation = yield* control.cancel(yield* Deferred.await(blocked.runId));

      assert.strictEqual(cancellation._tag, "Interrupting");
      if (cancellation._tag === "Interrupting") yield* cancellation.awaitTermination;
      yield* Fiber.await(running);

      assert.lengthOf(
        (yield* Ref.get(calls)).filter((call) => call.method === "release"),
        1,
      );
    }).pipe(
      Effect.provide(
        provide(
          [runner(implementEvents)],
          blocked.worktree,
          noopProviderLayer,
          trackerRecorder(),
          runnableStages,
          ContextCleanupCalls.contextAssemblerLayer,
          pluginManagerStub,
          [],
          controlStoreLayer(runnableStages, []),
          runLedgerIdentity,
          connectionStoreStub,
          blocked.runControl,
        ),
      ),
      Effect.scoped,
    );
  });

  it.effect("releases the claim without ledgering a Run when preparation is interrupted", () => {
    return Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const cleanups = yield* ContextCleanupCalls;
      const { entered } = yield* WorktreeProbe;
      const executor = yield* Executor.Executor;
      const ledger = yield* RunLedger.RunLedger;
      yield* execute(executor, implementWorkspace, implementItem);
      const running = yield* Effect.forkChild(execute(executor, implementWorkspace, implementItem));

      yield* Deferred.await(entered);

      const runs = yield* ledger.listRuns(10);
      assert.strictEqual(runs.length, 1);
      assert.strictEqual(runs[0]?.status, "succeeded");

      yield* Fiber.interrupt(running);
      assert.strictEqual((yield* Ref.get(calls)).filter((call) => call.method === "release").length, 2);
      assert.lengthOf(yield* Ref.get(cleanups), 2);
    }).pipe(Effect.provide(provide([runner(implementEvents)], interruptiblePrepareWorktree)), Effect.scoped);
  });

  it.effect("ledgers the newest session when the harness starts a fresh one mid-run", () => {
    const restarted: ReadonlyArray<AgUiEvent> = [
      ...implementStreamEvents,
      sessionEvent("sess-99"),
      implementFinished,
    ];

    return Effect.gen(function* () {
      const executor = yield* Executor.Executor;
      yield* execute(executor, implementWorkspace, implementItem);

      const ledger = yield* RunLedger.RunLedger;
      const [run] = yield* ledger.listRuns(10);
      assert.strictEqual(yield* handleOf(ledger, run?.session), "sess-99");
    }).pipe(Effect.provide(provide([runner(restarted)])));
  });

  it.effect("fails a resumed implement run when the harness rejects its session", () => {
    const resumeItem: EligibleWork = {
      ...implementItem,
      resume: { session: previousSession, reason: "interrupted" },
    };

    return Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const requests = yield* HarnessRequests;
      const executor = yield* Executor.Executor;
      yield* seedResumeSession();
      yield* execute(executor, implementWorkspace, resumeItem);

      const captured = yield* Ref.get(requests);
      assert.strictEqual(captured.length, 1);

      const [nudge] = captured;
      assert.strictEqual(nudge?.session, previousSession);
      assert.include(nudge?.plan.messages[0]?.content ?? "", "You were interrupted part-way through");

      const log = yield* Ref.get(calls);
      assert.isTrue(log.some((c) => c.method === "attemptFailed"));
      assert.isFalse(log.some((c) => c.method === "implemented"));

      const ledger = yield* RunLedger.RunLedger;
      const [run] = yield* ledger.listRuns(10);
      assert.strictEqual(yield* handleOf(ledger, run?.session), "sess-prev");
      assert.strictEqual(run?.status, "failed");
      assert.strictEqual(
        run ? (yield* ledger.events(run.id).pipe(Stream.runCollect)).at(-1)?.type : null,
        "RUN_FINISHED",
      );
    }).pipe(Effect.provide(provide([capturingRunner(implementEvents)])));
  });

  it.effect("fails a resumed triage run when the harness rejects its session", () => {
    const resumeItem: EligibleWork = {
      ...triageItem,
      resume: { session: previousSession, reason: "interrupted" },
    };

    return Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const requests = yield* HarnessRequests;
      const executor = yield* Executor.Executor;
      yield* seedResumeSession();
      yield* execute(executor, workspace, resumeItem);

      const captured = yield* Ref.get(requests);
      assert.strictEqual(captured.length, 1);

      const [nudge] = captured;
      assert.strictEqual(nudge?.session, previousSession);
      assert.include(nudge?.plan.messages[0]?.content ?? "", "You were interrupted part-way through");

      const log = yield* Ref.get(calls);
      assert.isTrue(log.some((c) => c.method === "attemptFailed"));
      assert.isFalse(log.some((c) => c.method === "triaged"));

      const ledger = yield* RunLedger.RunLedger;
      const [run] = yield* ledger.listRuns(10);
      assert.strictEqual(yield* handleOf(ledger, run?.session), "sess-prev");
      assert.strictEqual(run?.status, "failed");
      assert.strictEqual(
        run ? (yield* ledger.events(run.id).pipe(Stream.runCollect)).at(-1)?.type : null,
        "RUN_FINISHED",
      );
    }).pipe(Effect.provide(provide([capturingRunner(successEvents)])));
  });

  it.effect("keeps the session of a run the harness failed mid-stream so the retry resumes it", () => {
    const error = new HarnessError({ reason: "turn", retryable: true, message: "network blip" });

    return Effect.gen(function* () {
      const requests = yield* HarnessRequests;
      const executor = yield* Executor.Executor;
      yield* execute(executor, implementWorkspace, implementItem);

      const ledger = yield* RunLedger.RunLedger;
      const [run] = yield* ledger.listRuns(10);
      assert.strictEqual(run?.status, "failed");
      assert.strictEqual(yield* handleOf(ledger, run?.session), "sess-42");

      yield* execute(executor, implementWorkspace, implementItem);
      const captured = yield* Ref.get(requests);
      assert.strictEqual(captured[1]?.session, run?.session);
      assert.strictEqual(yield* handleOf(ledger, captured[1]?.session), "sess-42");
    }).pipe(Effect.provide(provide([capturingRunner(implementStreamEvents, Stream.fail(error))])));
  });

  it.effect("rejects a different handle during an ordinary same-Harness retry", () => {
    const error = new HarnessError({ reason: "turn", retryable: true, message: "network blip" });
    const first = Stream.concat(Stream.fromArray(implementStreamEvents), Stream.fail(error));
    const restarted = Stream.fromArray(
      implementEvents.map((event) => replaceSessionHandle(event, "sess-restarted")),
    );

    return Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const requests = yield* HarnessRequests;
      const executor = yield* Executor.Executor;
      yield* execute(executor, implementWorkspace, implementItem);
      yield* execute(executor, implementWorkspace, implementItem);

      const captured = yield* Ref.get(requests);
      assert.strictEqual(captured[1]?.session, captured[0]?.session);

      const ledger = yield* RunLedger.RunLedger;
      assert.strictEqual(yield* handleOf(ledger, captured[1]?.session), "sess-42");
      assert.isTrue((yield* Ref.get(calls)).some((call) => call.method === "attemptFailed"));
    }).pipe(Effect.provide(provide([sequenceRunner([first, restarted])])));
  });

  const exhaustedImplementFailure = new HarnessError({
    reason: "launch",
    retryable: false,
    message: "no cli",
  });
  const pullRequestLookupFailure = new IssueTrackerError({
    reason: "unavailable",
    retryable: true,
    message: "pull request lookup unavailable",
  });
  const exhaustedImplementCases = [
    {
      name: "exhausts a failed implement job and hands the issue back to a human",
      options: {},
      expectedHandOffStage: "implement",
    },
    {
      name: "does not hand off an exhausted implement job with an open pull request",
      options: { existingHead: implementBranch },
      expectedHandOffStage: undefined,
    },
    {
      name: "hands off an exhausted implement job when pull request lookup fails",
      options: { findError: pullRequestLookupFailure },
      expectedHandOffStage: "implement",
    },
  ] satisfies ReadonlyArray<{
    readonly name: string;
    readonly options: PullRequestProviderOptions;
    readonly expectedHandOffStage: "implement" | undefined;
  }>;

  it.effect.each(exhaustedImplementCases)("$name", ({ options, expectedHandOffStage }) =>
    Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const pullRequests = yield* PullRequestCalls;
      const executor = yield* Executor.Executor;
      yield* execute(executor, implementWorkspace, implementItem);

      const log = yield* Ref.get(calls);
      assert.strictEqual(log.find((call) => call.method === "attemptFailed")?.stage, "implement");
      assert.strictEqual(log.find((call) => call.method === "handOff")?.stage, expectedHandOffStage);
      assert.strictEqual(yield* Ref.get(pullRequests.observations), 1);

      const ledger = yield* RunLedger.RunLedger;
      const [run] = yield* ledger.listRuns(10);
      assert.strictEqual(run?.stage, "implement");
      assert.strictEqual(run?.status, "exhausted");
    }).pipe(
      Effect.provide(
        provide(
          [failingRunner(exhaustedImplementFailure)],
          worktreeStubLayer,
          pullRequestProvider(options),
        ).pipe(Layer.provideMerge(PullRequestCalls.layer)),
      ),
    ),
  );

  it.effect("does not publish a human attach command for a programmatic-only session", () => {
    const error = new HarnessError({ reason: "turn", retryable: false, message: "resume failed" });

    return Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const executor = yield* Executor.Executor;
      yield* execute(executor, implementWorkspace, implementItem);

      const handOff = (yield* Ref.get(calls)).find((call) => call.method === "handOff");
      assert.notInclude(handOff?.note ?? "", "Resume the session");
      assert.notInclude(handOff?.note ?? "", "codex resume");
    }).pipe(
      Effect.provide(
        provide([
          capturingRunner(
            [runStarted, sessionEvent("cursor-acp-session")],
            Stream.fail(error),
            "opaque-handle",
            cursor,
            false,
          ),
        ]),
      ),
    );
  });

  it.effect("hands a diverged worktree to a human on the first attempt without retrying", () => {
    const resumeItem: EligibleWork = {
      ...implementItem,
      resume: { session: previousSession, reason: "interrupted" },
    };

    return Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const requests = yield* HarnessRequests;
      const executor = yield* Executor.Executor;
      yield* seedResumeSession();
      yield* execute(executor, implementWorkspace, resumeItem);

      assert.strictEqual((yield* Ref.get(requests)).length, 0);
      const log = yield* Ref.get(calls);
      const attempt = log.find((c) => c.method === "attemptFailed");
      assert.strictEqual(attempt?.stage, "implement");
      assert.include(attempt?.reason ?? "", "diverged");
      const handOff = log.find((c) => c.method === "handOff");
      assert.strictEqual(handOff?.stage, "implement");
      assert.include(handOff?.note ?? "", "non-retryable failure");
      assert.include(handOff?.note ?? "", "diverged");
      assert.include(handOff?.note ?? "", "sess-prev");

      const ledger = yield* RunLedger.RunLedger;
      assert.deepStrictEqual(yield* ledger.listRuns(10), []);
    }).pipe(Effect.provide(provide([capturingRunner(implementEvents)], divergedWorktree)));
  });

  it.effect("uses the read-only checkout in a pre-preparation hand-off", () => {
    const resumeItem: EligibleWork = {
      ...implementItem,
      resume: { session: previousSession, reason: "interrupted" },
    };
    const permissionProfile: OperationSettingRow = {
      setting: "permission-profile",
      level: { _tag: "Operation", workflow: "coding", operation: "implement" },
      scope: { _tag: "PrivateWorkspaceOverlay", workspace: implementWorkspace.config.name },
      value: "read-only",
    };
    const readOnlyRunner = runner(implementEvents, {
      ...fullHarnessExecution,
      profiles: ["read-only"],
    });

    return Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const executor = yield* Executor.Executor;
      yield* seedResumeSession();
      yield* execute(executor, implementWorkspace, resumeItem);

      const handOff = (yield* Ref.get(calls)).find((call) => call.method === "handOff");
      assert.include(handOff?.note ?? "", "cd '/repos/gh' && codex resume 'sess-prev'");
    }).pipe(
      Effect.provide(
        provide(
          [readOnlyRunner],
          worktreeStubLayer,
          noopProviderLayer,
          trackerRecorder(),
          [...runnableStages, permissionProfile],
          failingAssemblyContext,
        ),
      ),
    );
  });

  it.effect("derives a pre-preparation follow-up hand-off from its linked external branch", () => {
    const item: EligibleWork = {
      ...followUpItem,
      followUpBranch: externalFollowUpBranch,
      resume: { session: previousSession, reason: "interrupted" },
    };

    return Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const executor = yield* Executor.Executor;
      yield* seedResumeSession();
      yield* execute(executor, followUpWorkspace, item);

      const handOff = (yield* Ref.get(calls)).find((call) => call.method === "handOff");
      assert.include(
        handOff?.note ?? "",
        "cd '/repos/gh.worktrees/review/external-branch' && codex resume 'sess-prev'",
      );
    }).pipe(Effect.provide(provide([capturingRunner(followUpEvents)], divergedExternalFollowUpWorktree)));
  });

  it.effect("hands a permanent Run acceptance failure to a human without retrying", () => {
    return Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const executor = yield* Executor.Executor;
      yield* execute(executor, implementWorkspace, implementItem);

      const log = yield* Ref.get(calls);
      const attempt = log.find((call) => call.method === "attemptFailed");
      assert.include(attempt?.reason ?? "", "persistence rejected");
      const handOff = log.find((call) => call.method === "handOff");
      assert.include(handOff?.note ?? "", "non-retryable failure");
    }).pipe(
      Effect.provide(
        provide(
          [runner(implementEvents)],
          worktreeStubLayer,
          noopProviderLayer,
          trackerRecorder(),
          runnableStages,
          ContextCleanupCalls.contextAssemblerLayer,
          pluginManagerStub,
          [],
          controlStoreLayer(runnableStages),
          failRunAcceptance(false),
        ),
      ),
    );
  });

  it.effect("hands a self-reported stuck implement run to a human without retrying", () => {
    return Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const executor = yield* Executor.Executor;
      yield* execute(executor, implementWorkspace, implementItem);

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
    }).pipe(Effect.provide(provide([runner(stuckImplementEvents)])));
  });

  it.effect("retries an implement run with a malformed structured result", () => {
    return Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const executor = yield* Executor.Executor;
      yield* execute(executor, implementWorkspace, implementItem);

      const log = yield* Ref.get(calls);
      assert.isFalse(log.some((call) => call.method === "implemented"));
      assert.include(
        log.find((call) => call.method === "attemptFailed")?.reason ?? "",
        "structured implement result",
      );
      assert.isFalse(log.some((call) => call.method === "handOff"));
    }).pipe(Effect.provide(provide([runner(malformedImplementResultEvents)])));
  });

  it.effect("runs a follow-up job, records the follow-up marker, and never hands off on success", () => {
    return Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const requests = yield* HarnessRequests;
      const executor = yield* Executor.Executor;
      yield* execute(executor, followUpWorkspace, followUpItem);

      const [request] = yield* Ref.get(requests);
      assert.strictEqual(request?.plan.sandbox.workspace, `/wt/${followUpBranch}`);
      assert.include(request?.plan.messages[0]?.content ?? "", "follow-up-agent");

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
    }).pipe(Effect.provide(provide([capturingRunner(followUpEvents)], existingWorktree)));
  });

  it.effect("posts the structured round summary to the pull request", () => {
    return Effect.gen(function* () {
      const posted = yield* PostedComments;
      const executor = yield* Executor.Executor;
      yield* execute(executor, followUpWorkspace, followUpItem);

      const [comment] = yield* Ref.get(posted);
      assert.strictEqual(comment?.item, "#5");
      assert.include(comment?.body ?? "", "Fixed the failing check and pushed");
      assert.include(comment?.body ?? "", "posted by cogwork");
    }).pipe(Effect.provide(provide([runner(followUpEvents)], existingWorktree, recordingProvider)));
  });

  it.effect("posts a noop summary when the round chooses to speak", () => {
    return Effect.gen(function* () {
      const posted = yield* PostedComments;
      const executor = yield* Executor.Executor;
      yield* execute(executor, followUpWorkspace, followUpItem);

      const [comment] = yield* Ref.get(posted);
      assert.include(comment?.body ?? "", "reported issue is expected behavior");
    }).pipe(
      Effect.provide(provide([runner(speakingNoopFollowUpEvents)], existingWorktree, recordingProvider)),
    );
  });

  it.effect("keeps a noop round silent when it has nothing to answer", () => {
    return Effect.gen(function* () {
      const posted = yield* PostedComments;
      const executor = yield* Executor.Executor;
      yield* execute(executor, followUpWorkspace, followUpItem);

      assert.isEmpty(yield* Ref.get(posted));
    }).pipe(Effect.provide(provide([runner(noopFollowUpEvents)], existingWorktree, recordingProvider)));
  });

  it.effect("settles a successful follow-up when posting its pull request summary fails", () => {
    return Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const executor = yield* Executor.Executor;
      yield* execute(executor, followUpWorkspace, followUpItem);

      const log = yield* Ref.get(calls);
      assert.isTrue(log.some((call) => call.method === "followedUp"));

      const ledger = yield* RunLedger.RunLedger;
      const [run] = yield* ledger.listRuns(10);
      assert.strictEqual(run?.status, "succeeded");
    }).pipe(
      Effect.provide(provide([runner(followUpEvents)], existingWorktree, unavailableCommentProviderLayer)),
    );
  });

  it.effect("posts no pull request summary when a follow-up hands itself off as stuck", () => {
    return Effect.gen(function* () {
      const posted = yield* PostedComments;
      const executor = yield* Executor.Executor;
      yield* execute(executor, followUpWorkspace, followUpItem);

      assert.isEmpty(yield* Ref.get(posted));
    }).pipe(Effect.provide(provide([runner(stuckFollowUpEvents)], existingWorktree, recordingProvider)));
  });

  it.effect(
    "treats a noop follow-up as a non-failure that records the marker and hands back for review",
    () => {
      return Effect.gen(function* () {
        const calls = yield* TrackerCalls;
        const executor = yield* Executor.Executor;
        yield* execute(executor, followUpWorkspace, followUpItem);

        const log = yield* Ref.get(calls);
        const followedUp = log.find((c) => c.method === "followedUp");
        assert.strictEqual(followedUp?.checks, "failing");
        assert.strictEqual(followedUp?.summary, "The PR is green and needs no code change.");
        assert.isFalse(log.some((c) => c.method === "attemptFailed"));
        assert.isFalse(log.some((c) => c.method === "handOff"));
        assert.isTrue(log.some((c) => c.method === "release"));

        const ledger = yield* RunLedger.RunLedger;
        const [run] = yield* ledger.listRuns(10);
        assert.strictEqual(run?.stage, "follow-up");
        assert.strictEqual(run?.status, "succeeded");
      }).pipe(Effect.provide(provide([runner(noopFollowUpEvents)], existingWorktree)));
    },
  );

  it.effect("starts the no-progress count over when the round pushed", () => {
    const carriedItem = {
      ...followUpItem,
      followUp: { ...followUpItem.followUp, noProgress: 2 },
    };

    return Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const executor = yield* Executor.Executor;
      yield* execute(executor, followUpWorkspace, carriedItem);

      const log = yield* Ref.get(calls);
      const followedUp = log.find((c) => c.method === "followedUp");
      assert.strictEqual(followedUp?.noProgress, 0);
    }).pipe(Effect.provide(provide([runner(followUpEvents)], existingWorktree)));
  });

  it.effect("carries the no-progress count forward when the round pushed nothing", () => {
    const carriedItem = {
      ...followUpItem,
      followUp: { ...followUpItem.followUp, noProgress: 2 },
    };

    return Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const executor = yield* Executor.Executor;
      yield* execute(executor, followUpWorkspace, carriedItem);

      const log = yield* Ref.get(calls);
      const followedUp = log.find((c) => c.method === "followedUp");
      assert.strictEqual(followedUp?.noProgress, 2);
    }).pipe(Effect.provide(provide([runner(noopFollowUpEvents)], existingWorktree)));
  });

  it.effect("hands a self-reported stuck follow-up to a human without retrying", () => {
    return Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const executor = yield* Executor.Executor;
      yield* execute(executor, followUpWorkspace, followUpItem);

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
    }).pipe(Effect.provide(provide([runner(stuckFollowUpEvents)], existingWorktree)));
  });

  it.effect("does not advance the stall count when a follow-up fails", () => {
    const item = { ...followUpItem, followUp: { ...followUpItem.followUp, noProgress: 2 } };
    return Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const executor = yield* Executor.Executor;
      yield* execute(executor, followUpWorkspace, item);

      const attempt = (yield* Ref.get(calls)).find((call) => call.method === "attemptFailed");
      assert.strictEqual(attempt?.noProgress, 1);
    }).pipe(Effect.provide(provide([runner(stuckFollowUpEvents)], existingWorktree)));
  });

  it.effect("does not consume follow-up wakes when a follow-up fails", () => {
    const previousMarker = {
      checks: "passing" as const,
      humanCommentAtMillis: 3,
      botTriggerAtMillis: 4,
      noProgress: 0,
      baseDivergence: "none" as const,
    };
    const item = {
      ...followUpItem,
      followUp: {
        ...followUpItem.followUp,
        previousMarker,
        humanCommentAtMillis: 10,
        botTriggerAtMillis: 20,
      },
    };
    return Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const executor = yield* Executor.Executor;
      yield* execute(executor, followUpWorkspace, item);

      const attempt = (yield* Ref.get(calls)).find((call) => call.method === "attemptFailed");
      assert.strictEqual(attempt?.humanCommentAtMillis, 3);
      assert.strictEqual(attempt?.botTriggerAtMillis, 4);
    }).pipe(Effect.provide(provide([runner(stuckFollowUpEvents)], existingWorktree)));
  });

  it.effect("snapshots pull request state before recording a failed follow-up", () => {
    return Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const executor = yield* Executor.Executor;
      yield* execute(executor, followUpWorkspace, followUpItem);

      const attempt = (yield* Ref.get(calls)).find((call) => call.method === "attemptFailed");
      assert.strictEqual(attempt?.baseDivergence, "conflict");
      assert.strictEqual(attempt?.latestFailingCheckAtMillis, 90);
    }).pipe(
      Effect.provide(provide([runner(stuckFollowUpEvents)], existingWorktree, conflictingProviderLayer)),
    );
  });

  it.effect.each([
    { name: "no pull request signal", provider: noopProviderLayer },
    { name: "refresh error", provider: failedObservationProviderLayer },
  ])("records a conflict when failure refresh has $name", ({ provider }) => {
    return Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const executor = yield* Executor.Executor;
      yield* execute(executor, followUpWorkspace, followUpItem);

      const attempt = (yield* Ref.get(calls)).find((call) => call.method === "attemptFailed");
      assert.strictEqual(attempt?.baseDivergence, "conflict");
    }).pipe(Effect.provide(provide([runner(stuckFollowUpEvents)], existingWorktree, provider)));
  });

  it.effect("omits a clock-capped failing check watermark from the failure marker", () => {
    return Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const executor = yield* Executor.Executor;
      yield* execute(executor, followUpWorkspace, followUpItem);

      const attempt = (yield* Ref.get(calls)).find((call) => call.method === "attemptFailed");
      assert.strictEqual(attempt?.latestFailingCheckAtMillis, undefined);
    }).pipe(
      Effect.provide(
        provide([runner(stuckFollowUpEvents)], existingWorktree, clockCappedFailingProviderLayer),
      ),
    );
  });

  it.effect("names the prepared linked-branch checkout in a follow-up hand-off", () => {
    const item: EligibleWork = { ...followUpItem, followUpBranch: externalFollowUpBranch };
    const error = new HarnessError({
      reason: "turn",
      retryable: false,
      message: "follow-up failed",
    });

    return Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const executor = yield* Executor.Executor;
      yield* execute(executor, followUpWorkspace, item);

      const handOff = (yield* Ref.get(calls)).find((call) => call.method === "handOff");
      assert.include(handOff?.note ?? "", `cd '${externalFollowUpCheckout}' && codex resume 'sess-linked'`);
    }).pipe(
      Effect.provide(
        provide(
          [capturingRunner([runStarted, sessionEvent("sess-linked")], Stream.fail(error))],
          externalFollowUpWorktree,
        ),
      ),
    );
  });

  it.effect("retries a follow-up with no structured result", () => {
    return Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const executor = yield* Executor.Executor;
      yield* execute(executor, followUpWorkspace, followUpItem);

      const log = yield* Ref.get(calls);
      assert.include(
        log.find((call) => call.method === "attemptFailed")?.reason ?? "",
        "structured follow-up result",
      );
      assert.isFalse(log.some((call) => call.method === "handOff"));
    }).pipe(Effect.provide(provide([runner(missingFollowUpResultEvents)], existingWorktree)));
  });

  it.effect("retries a follow-up with a malformed structured result", () => {
    return Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const executor = yield* Executor.Executor;
      yield* execute(executor, followUpWorkspace, followUpItem);

      const log = yield* Ref.get(calls);
      assert.include(
        log.find((call) => call.method === "attemptFailed")?.reason ?? "",
        "structured follow-up result",
      );
      assert.isFalse(log.some((call) => call.method === "handOff"));
    }).pipe(Effect.provide(provide([runner(malformedFollowUpResultEvents)], existingWorktree)));
  });

  it.effect("hands a stalled follow-up to a human when its Operation is unavailable", () => {
    const stalledItem = {
      ...followUpItem,
      followUp: { ...followUpItem.followUp, noProgress: 3, stalled: true },
    };

    return Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const requests = yield* HarnessRequests;
      const executor = yield* Executor.Executor;
      const started = yield* execute(executor, followUpWorkspace, stalledItem);

      assert.isTrue(started);
      assert.strictEqual((yield* Ref.get(requests)).length, 0);
      const log = yield* Ref.get(calls);
      const stalled = log.find((c) => c.method === "stalled");
      assert.isDefined(stalled);
      assert.include(stalled?.detail ?? "", "no progress");
      assert.strictEqual(stalled?.checks, "failing");
      assert.isFalse(log.some((c) => c.method === "handOff"));
      // The hand-off parks the count so whoever hands the item back gets a fresh three rounds
      // instead of an item that claims and abandons in the same breath.
      assert.strictEqual(stalled?.noProgress, 0);

      const ledger = yield* RunLedger.RunLedger;
      assert.strictEqual((yield* ledger.listRuns(10)).length, 0);
    }).pipe(
      Effect.provide(
        provide(
          [capturingRunner(followUpEvents)],
          worktreeStubLayer,
          noopProviderLayer,
          trackerRecorder(),
          [],
          ContextCleanupCalls.contextAssemblerLayer,
          missingPluginCredentialLayer,
        ),
      ),
    );
  });

  it.effect("does not claim a stalled follow-up for a disabled Harness", () => {
    const stalledItem = {
      ...followUpItem,
      followUp: { ...followUpItem.followUp, noProgress: 3, stalled: true },
    };

    return Effect.gen(function* () {
      const calls = yield* TrackerCalls;
      const executor = yield* Executor.Executor;

      assert.isFalse(yield* execute(executor, followUpWorkspace, stalledItem));
      assert.deepStrictEqual(yield* Ref.get(calls), []);
    }).pipe(
      Effect.provide(
        provide(
          [capturingRunner(followUpEvents)],
          worktreeStubLayer,
          noopProviderLayer,
          trackerRecorder(),
          runnableStages,
          ContextCleanupCalls.contextAssemblerLayer,
          pluginManagerStub,
          [],
          controlStoreLayer(runnableStages, [], [{ harness: cursor, enabled: false }]),
        ),
      ),
    );
  });

  it.effect("claims a stalled follow-up while holding the Control store write gate", () => {
    const stalledItem = {
      ...followUpItem,
      followUp: { ...followUpItem.followUp, noProgress: 3, stalled: true },
    };
    const writeActive = Ref.makeUnsafe(false);

    return Effect.gen(function* () {
      const executor = yield* Executor.Executor;
      assert.isTrue(yield* execute(executor, followUpWorkspace, stalledItem));
    }).pipe(
      Effect.provide(
        provide(
          [capturingRunner(followUpEvents)],
          worktreeStubLayer,
          noopProviderLayer,
          trackerRecorder(undefined, writeActive),
          runnableStages,
          ContextCleanupCalls.contextAssemblerLayer,
          pluginManagerStub,
          [],
          observedWriteGateControlStoreLayer(writeActive),
        ),
      ),
    );
  });

  it.effect(
    "retries an implement run with no structured result and resumes its session on the next attempt",
    () => {
      return Effect.gen(function* () {
        const calls = yield* TrackerCalls;
        const requests = yield* HarnessRequests;
        const executor = yield* Executor.Executor;
        yield* execute(executor, implementWorkspace, implementItem);

        const log = yield* Ref.get(calls);
        const attempt = log.find((c) => c.method === "attemptFailed");
        assert.strictEqual(attempt?.stage, "implement");
        assert.include(attempt?.reason ?? "", "structured implement result");
        assert.isFalse(log.some((c) => c.method === "handOff"));

        const ledger = yield* RunLedger.RunLedger;
        const [firstRun] = yield* ledger.listRuns(10);
        assert.strictEqual(firstRun?.status, "failed");
        assert.strictEqual(yield* handleOf(ledger, firstRun?.session), "sess-42");

        yield* execute(executor, implementWorkspace, implementItem);
        const captured = yield* Ref.get(requests);
        assert.strictEqual(captured[1]?.session, firstRun?.session);
        assert.strictEqual(yield* handleOf(ledger, captured[1]?.session), "sess-42");
      }).pipe(Effect.provide(provide([capturingRunner(missingImplementResultEvents)])));
    },
  );

  it.effect("announces the accepted Run with its session, then settles", () => {
    return Effect.gen(function* () {
      const executor = yield* Executor.Executor;
      const bus = yield* DaemonEventBus.DaemonEventBus;
      const subscription = yield* bus.subscribe();
      yield* execute(executor, workspace, triageItem);

      const events = yield* Stream.fromSubscription(subscription).pipe(
        Stream.takeUntil((event) => DaemonEvent.guards.RunChanged(event) && event.run.status === "succeeded"),
        Stream.runCollect,
      );
      const runChanges = [...events].flatMap((event) =>
        DaemonEvent.guards.RunChanged(event) ? [event.run] : [],
      );
      assert.deepStrictEqual(
        runChanges.map((run) => run.status),
        ["running", "succeeded"],
      );
      assert.isNotNull(runChanges[0]?.session ?? null);
      assert.strictEqual(runChanges[0]?.session, runChanges.at(-1)?.session);
      assert.strictEqual(runChanges.at(-1)?.eventCount, successEvents.length);
    }).pipe(Effect.provide(provide([runner(successEvents)])), Effect.scoped);
  });
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
