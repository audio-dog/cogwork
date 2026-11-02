import {
  AttemptRecord,
  Claim,
  HandbackRecord,
  HarnessName,
  keyOf,
  LineageId,
  localOwnerId,
  type ParkReason,
  ParkRecord,
  Principal,
  RunId,
  SessionId,
  WorkflowActionArtifact,
  WorkflowActionPlan,
  WorkflowActionPlanStep,
  type WorkflowCatalogEntry,
  WorkflowCatalogKey,
  WorkflowDocument,
  WorkflowId,
  WorkflowNodeId,
  type WorkflowRecord,
  WorkItemId,
  WorkspaceConfig,
  WorkspaceId,
} from "@cogwork/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { clockEntries } from "./clock-source";
import { ContextAssembler } from "./context-assembler";
import { Coordination, CoordinationError, type CoordinationService, fold } from "./coordination";
import * as CredentialStore from "./credential-store";
import {
  fullHarnessExecution,
  Harness,
  HarnessError,
  type HarnessRunner,
  make as makeHarness,
} from "./harness";
import {
  emptyLayer as emptyIssueTrackerLayer,
  IssueTracker,
  type IssueTrackerService,
  makeEmpty as makeEmptyIssueTracker,
} from "./issue-tracker";
import type { RegisteredWorkspace } from "./projector";
import { defaultRunBudget } from "./provider-runner";
import { emptyRegistry, type RegistryState, readOnlyRegistry, WorkspaceRegistry } from "./registry";
import { RunLedger } from "./run-ledger";
import { RunRecorder } from "./run-recorder";
import { SlackWrite } from "./slack-write";
import { engineTestLayer } from "./testing/engine-test-layer";
import {
  makeMemoryTriggerObservationStore,
  type TriggerAdmission,
  TriggerObservationStore,
  TriggerObservationStoreError,
  type TriggerObservationStoreService,
} from "./trigger-observation";
import { Workflows, type WorkflowsService } from "./workflow";
import {
  WorkflowActionPlanStore,
  memoryLayer as workflowActionPlanStoreLayer,
} from "./workflow-action-plan-store";
import { WorkflowArtifactStore, memoryLayer as workflowArtifactStoreLayer } from "./workflow-artifact-store";
import { make as makeNotifications, WorkflowNotifications } from "./workflow-notification";
import { make as makeWorkflowRun } from "./workflow-run";

const decodeWorkflow = Schema.decodeSync(WorkflowId);
const decodeNode = Schema.decodeSync(WorkflowNodeId);
const decodeEntry = Schema.decodeSync(WorkflowCatalogKey);
const decodeRun = Schema.decodeSync(RunId);
const decodeSession = Schema.decodeSync(SessionId);
const decodeWorkItem = Schema.decodeSync(WorkItemId);
const decodeWorkspace = Schema.decodeSync(WorkspaceId);
const workflow = decodeWorkflow("daily-summary");
const siblingWorkflow = decodeWorkflow("sibling-summary");
const trigger = decodeNode("schedule");
const siblingTrigger = decodeNode("schedule-sibling");
const operation = decodeNode("summarize");
const harnessName = Schema.decodeSync(HarnessName)("scripted");
const notifyEntry = decodeEntry("cogwork.notify");
const waitForApprovalEntry = decodeEntry("cogwork.wait-for-approval");
const handToMeEntry = decodeEntry("cogwork.hand-to-me");
const scheduleEntry = decodeEntry("schedule.daily");
const decodeDecisionValue = Schema.decodeUnknownSync(
  Schema.Struct({
    object: Schema.Record(Schema.String, Schema.Unknown),
    raw: Schema.String,
  }),
);

const document = Schema.decodeSync(WorkflowDocument)({
  name: "Daily summary",
  workspaces: { _tag: "Listed", workspaces: [] },
  triggers: [trigger, siblingTrigger].map((id) => ({
    id,
    entry: scheduleEntry,
    parameters: [],
    start: operation,
  })),
  operations: [
    {
      id: operation,
      name: "Summarize",
      instructionPackage: "implement-agent",
      instruction: "Summarize the day.",
      permissionProfile: "read-only",
      requires: [],
      model: { harness: harnessName, model: null, options: [] },
      forEach: null,
      questions: [
        { id: decodeNode("done"), text: "Done?", choices: [{ id: decodeNode("yes"), name: "Yes" }] },
      ],
      transitions: [
        {
          when: [{ question: decodeNode("done"), choice: decodeNode("yes") }],
          actions: [{ entry: notifyEntry, parameters: [] }],
          handOff: null,
        },
      ],
      hints: [],
    },
  ],
});

const workflowRecord: WorkflowRecord = {
  id: workflow,
  principal: localOwnerId,
  workingCopy: document,
  workingRevision: 1,
  publishedCopy: document,
  publishedRevision: 1,
  enabled: true,
  diagnostics: [],
  readiness: [],
};

const workflowService: WorkflowsService = {
  create: () => Effect.die("unused"),
  edit: () => Effect.die("unused"),
  publish: () => Effect.die("unused"),
  switch: () => Effect.die("unused"),
  delete: () => Effect.die("unused"),
  list: Effect.succeed({ workflows: [workflowRecord], unreadable: [] }),
  get: () => Effect.succeed(workflowRecord),
  validate: () => Effect.succeed([]),
  catalog: Effect.succeed({
    catalog: {
      entries: [
        ...clockEntries,
        {
          key: notifyEntry,
          name: "Notify me",
          kind: "action",
          system: null,
          connection: null,
          requires: [],
          parameters: [],
          itemKind: null,
          actsOn: ["*"],
          requiresWorkspace: false,
          permissionProfile: "read-only",
          agentInputs: ["notification"],
          emits: [],
        },
        {
          key: handToMeEntry,
          name: "Hand to me",
          kind: "action",
          system: null,
          connection: null,
          requires: [],
          parameters: [],
          itemKind: null,
          actsOn: ["*"],
          requiresWorkspace: false,
          permissionProfile: "read-only",
          agentInputs: ["hand_off"],
          emits: [],
        },
      ],
      instructionPackages: [],
      harnesses: [],
    },
    machine: {
      workspaces: [],
      connections: [],
      harnesses: [{ name: harnessName, available: true }],
      defaultHarness: harnessName,
      readyNeeds: [],
    },
  }),
  templates: Effect.succeed([]),
  listOptions: () => Effect.succeed([]),
};

const waitForApprovalCatalogEntry = {
  key: waitForApprovalEntry,
  name: "Wait for my approval",
  kind: "action" as const,
  system: null,
  connection: null,
  requires: [],
  parameters: [],
  itemKind: null,
  actsOn: ["*"],
  requiresWorkspace: false,
  permissionProfile: "read-only" as const,
  agentInputs: ["approval_request"],
  emits: [],
};

const workflowServiceFor = (
  publishedCopy: WorkflowDocument,
  entries: ReadonlyArray<WorkflowCatalogEntry> = [],
): WorkflowsService => ({
  ...workflowService,
  get: () => Effect.succeed({ ...workflowRecord, workingCopy: publishedCopy, publishedCopy }),
  catalog: workflowService.catalog.pipe(
    Effect.map((result) => ({
      ...result,
      catalog: { ...result.catalog, entries: [...result.catalog.entries, ...entries] },
    })),
  ),
});

const documentWithTransition = (transition: {
  readonly when: ReadonlyArray<{ readonly question: WorkflowNodeId; readonly choice: WorkflowNodeId }>;
  readonly actions: ReadonlyArray<{
    readonly entry: WorkflowCatalogKey;
    readonly parameters: ReadonlyArray<never>;
  }>;
  readonly handOff: WorkflowNodeId | null;
}) => {
  const [summarize] = document.operations;
  if (summarize === undefined) return Effect.die("Missing test Operation");
  return Schema.decodeEffect(WorkflowDocument)({
    ...document,
    operations: [{ ...summarize, transitions: [transition] }],
  });
};

const workflowServiceWith = (publishedCopy: WorkflowDocument): WorkflowsService => ({
  ...workflowService,
  list: Effect.succeed({
    workflows: [{ ...workflowRecord, workingCopy: publishedCopy, publishedCopy }],
    unreadable: [],
  }),
  get: () => Effect.succeed({ ...workflowRecord, workingCopy: publishedCopy, publishedCopy }),
});

const admission: TriggerAdmission = {
  event: {
    key: { _tag: "ScheduleInstant", workflow, instantMillis: 1_000 },
    revision: "1000",
    cause: { _tag: "Unknown" },
    atMillis: 1_000,
    entry: scheduleEntry,
    workspace: null,
    workContext: {
      body: "Slack conversation in #reviews\nPermalink: https://example.slack.com/message",
      comments: [
        {
          author: "Taylor",
          authorAssociation: null,
          body: "Please review this.",
          createdAtMillis: 900,
        },
      ],
    },
  },
  subscription: {
    workflow,
    trigger,
    operation,
    entry: scheduleEntry,
    parameters: [],
    workspaces: [],
    catchUp: { since: 0 },
  },
  lineage: {
    root: Schema.decodeSync(Schema.String.pipe(Schema.brand("LineageId")))("schedule:1000"),
    parent: null,
    hop: 0,
  },
};

const granolaAdmission: TriggerAdmission = {
  ...admission,
  event: {
    ...admission.event,
    key: {
      _tag: "GranolaNote",
      connection: Schema.decodeSync(Schema.String.pipe(Schema.brand("ConnectionId")))(
        "granola/person@example.com",
      ),
      noteId: "note-1",
    },
    revision: "2026-10-29T15:00:00.000Z",
    atMillis: Date.UTC(2026, 9, 29, 15),
    workContext: undefined,
    payload: {
      _tag: "GranolaNote",
      title: "Weekly product sync",
      attendees: ["Taylor <taylor@example.com>", "Ari <ari@example.com>"],
      calendarEvent: "Weekly product sync · 2026-10-29 09:00 MDT",
      summary: "Decided to ship the smaller change.",
      transcript: "Taylor: Ship the smaller change.\nAri: Agreed.",
    },
  },
};

const siblingGranolaAdmission: TriggerAdmission = {
  ...granolaAdmission,
  subscription: { ...granolaAdmission.subscription, trigger: siblingTrigger },
};

const makeCoordination = () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make<ReadonlyArray<AttemptRecord>>([]);
    const parks = yield* Ref.make<ReadonlyArray<ParkRecord>>([]);
    const handbacks = yield* Ref.make<ReadonlyArray<HandbackRecord>>([]);
    const processed = yield* Ref.make<string | null>(null);
    const observed = yield* Ref.make("1000");
    const claims = yield* Ref.make(0);
    const activeClaim = yield* Ref.make<Claim | null>(null);
    const read = (_ref?: unknown) =>
      Effect.all([
        Ref.get(attempts),
        Ref.get(parks),
        Ref.get(processed),
        Ref.get(handbacks),
        Ref.get(observed),
        Ref.get(activeClaim),
      ]).pipe(
        Effect.map(
          ([
            currentAttempts,
            currentParks,
            currentProcessed,
            currentHandbacks,
            currentObserved,
            currentClaim,
          ]) =>
            fold(
              {
                claim: currentClaim,
                attempts: currentAttempts,
                handbacks: currentHandbacks,
                parks: currentParks,
                revision: { observed: currentObserved, processed: currentProcessed },
              },
              "cogwork",
            ),
        ),
      );
    return {
      service: {
        fold,
        read,
        claim: (_ref, input) =>
          Ref.update(claims, (current) => current + 1).pipe(
            Effect.andThen(Effect.sync(() => Claim.make({ ...input, by: "cogwork", claimedAtMillis: 1 }))),
            Effect.tap((claim) => Ref.set(activeClaim, claim)),
          ),
        release: () => Ref.set(activeClaim, null),
        recordAttempt: (_ref, input) =>
          Ref.update(attempts, (current) => [
            ...current,
            AttemptRecord.make({ ...input, atMillis: current.length + 1 }),
          ]).pipe(Effect.andThen(read())),
        park: (_ref, reason: ParkReason, operation) =>
          Ref.update(parks, (current) => [
            ...current,
            ParkRecord.make({
              reason,
              ...(operation ? { operation } : {}),
              atMillis: current.length + 1,
            }),
          ]).pipe(Effect.andThen(read())),
        handBack: (_ref, input = { by: "Taylor" }) =>
          Ref.update(handbacks, (current) => [
            ...current,
            HandbackRecord.make({ by: input.by, atMillis: 2_000, note: input.note ?? null }),
          ]).pipe(Effect.andThen(read())),
        observe: () => Effect.succeed("moved"),
        markProcessed: (_ref, revision) => Ref.set(processed, revision),
      } satisfies CoordinationService,
      attempts,
      parks,
      processed,
      observed,
      claims,
    };
  });

const resultEvent = (object: unknown) => ({
  type: "CUSTOM" as const,
  name: "structured-output.complete" as const,
  value: { object, raw: JSON.stringify(object) },
});

const requirements = Layer.mergeAll(
  engineTestLayer(),
  Layer.succeed(Principal, { id: localOwnerId }),
  emptyIssueTrackerLayer,
  Layer.succeed(WorkspaceRegistry, readOnlyRegistry(emptyRegistry)),
  workflowActionPlanStoreLayer,
  workflowArtifactStoreLayer,
  CredentialStore.layerEnv,
  NodeServices.layer,
  FetchHttpClient.layer,
  Layer.mock(SlackWrite, {
    sendMessage: () => Effect.die("unused"),
    replyInThread: () => Effect.die("unused"),
    addReaction: () => Effect.die("unused"),
    draftReply: () => Effect.die("unused"),
  }),
  Layer.mock(ContextAssembler, {
    assemble: ({ operatingInstructions }) =>
      Effect.succeed({
        layers: [
          {
            kind: "operating-instructions",
            source: "workflow-operation",
            content:
              typeof operatingInstructions === "string"
                ? operatingInstructions
                : `${operatingInstructions.instructionPackage}:${operatingInstructions.instruction}`,
          },
        ],
        operatingInstructionsName: "workflow-operation",
        operatingInstructionsPath: "/tmp/workflow-operation",
        operatingInstructionResources: [],
        sources: [],
      }),
    cleanup: () => Effect.void,
  }),
);

interface HarnessBehavior {
  readonly preflight?: HarnessRunner["preflight"];
  readonly run?: HarnessRunner["run"];
  readonly coordination?: (service: CoordinationService) => CoordinationService;
  readonly observationStore?: (service: TriggerObservationStoreService) => TriggerObservationStoreService;
  readonly issueTracker?: IssueTrackerService;
  readonly registry?: RegistryState;
}

const testProgram = (
  objects: ReadonlyArray<unknown>,
  behavior: HarnessBehavior = {},
  service: WorkflowsService = workflowService,
) =>
  Effect.gen(function* () {
    const output = yield* Ref.make(objects);
    const coordination = yield* makeCoordination();
    const baseObservationStore = yield* makeMemoryTriggerObservationStore;
    const observationStore = behavior.observationStore?.(baseObservationStore) ?? baseObservationStore;
    const notifications = yield* makeNotifications;
    const issueTracker = behavior.issueTracker ?? (yield* IssueTracker);
    const registry = readOnlyRegistry(behavior.registry ?? emptyRegistry);
    const harness = makeHarness([
      {
        name: harnessName,
        sessionKind: "owned-transcript",
        projectedMembers: [],
        planMiddleware: ["sandbox", "persistence", "instruction-context"],
        execution: fullHarnessExecution,
        capabilities: {
          authenticationModes: ["host"],
          session: { affinity: "portable", fork: false, humanAttach: false },
          structuredOutput: "native",
          policyFidelity: "exact",
          fileEventFidelity: "absent",
          usageQuality: "none",
          readinessDiagnostics: false,
          journal: false,
          takeover: false,
        },
        authentication: { mode: "host", reference: "test" },
        catalog: { models: [] },
        readiness: () =>
          Effect.succeed({
            operational: { status: "ready", retryable: false, diagnostic: "ready" },
            installation: { status: "installed", version: "1" },
            compatibility: { status: "compatible", requirement: null },
            authentication: { mode: "host", status: "available", diagnostic: "ready" },
            diagnostics: [],
          }),
        preflight: behavior.preflight ?? (() => Effect.void),
        run:
          behavior.run ??
          (() => Stream.fromEffect(Ref.modify(output, ([next, ...rest]) => [resultEvent(next), rest]))),
      },
    ]);
    const runner = yield* makeWorkflowRun.pipe(
      Effect.provideService(Workflows, service),
      Effect.provideService(
        Coordination,
        behavior.coordination?.(coordination.service) ?? coordination.service,
      ),
      Effect.provideService(TriggerObservationStore, observationStore),
      Effect.provideService(Harness, harness),
      Effect.provideService(IssueTracker, issueTracker),
      Effect.provideService(WorkspaceRegistry, registry),
      Effect.provideService(WorkflowNotifications, notifications),
    );
    return { runner, coordination, notifications, observationStore };
  });

const exerciseFanOut = Effect.fn("WorkflowRunTest.exerciseFanOut")(function* (
  summaries: ReadonlyArray<string>,
) {
  const fanOutDocument = WorkflowDocument.make({
    ...document,
    operations: document.operations.map((candidate) => ({
      ...candidate,
      forEach: "commitment",
    })),
  });
  const { runner, notifications, observationStore } = yield* testProgram(
    [
      {
        summary: summaries.length === 0 ? "No commitments" : "Three commitments",
        stuck: false,
        elements: summaries.map((summary) => ({
          summary,
          answers: { done: "yes" },
          inputs: { notification: summary },
        })),
      },
    ],
    {},
    workflowServiceWith(fanOutDocument),
  );
  yield* observationStore.putAll([granolaAdmission]);

  assert.strictEqual(yield* runner.execute(granolaAdmission), "completed");
  const children = yield* observationStore.admissions;
  assert.lengthOf(children, summaries.length);
  const childRun = children[0]?.event.key._tag === "FanOutChild" ? children[0].event.key.run : null;
  assert.deepStrictEqual(
    children.map(({ event, lineage }) => ({
      tag: event.key._tag,
      parent: event.key._tag === "FanOutChild" ? event.key.parent : null,
      run: event.key._tag === "FanOutChild" ? event.key.run : null,
      position: event.key._tag === "FanOutChild" ? event.key.position : null,
      lineage,
    })),
    summaries.map((_, position) => ({
      tag: "FanOutChild" as const,
      parent: keyOf(granolaAdmission.event.key),
      run: childRun,
      position,
      lineage: {
        root: granolaAdmission.lineage.root,
        parent: childRun === null ? null : LineageId.make(childRun),
        hop: 1,
      },
    })),
  );
  yield* Effect.forEach(children, runner.execute, { discard: true });
  assert.deepStrictEqual(
    (yield* notifications.list).map(({ summary }) => summary),
    [...summaries],
  );
});

describe("WorkflowRun", () => {
  it.effect("fans each result element into one child item with inherited lineage", () =>
    Effect.forEach([[], ["First", "Second", "Third"]] as const, exerciseFanOut, {
      discard: true,
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("retries a failed fan-out without exposing duplicate children", () =>
    Effect.gen(function* () {
      const fanOutDocument = WorkflowDocument.make({
        ...document,
        operations: document.operations.map((candidate) => ({ ...candidate, forEach: "commitment" })),
      });
      const output = {
        summary: "Two commitments",
        stuck: false,
        elements: ["First", "Second"].map((summary) => ({
          summary,
          answers: { done: "yes" },
          inputs: { notification: summary },
        })),
      };
      const failFanOut = yield* Ref.make(true);
      const { runner, observationStore } = yield* testProgram(
        [output, output],
        {
          observationStore: (base) => ({
            ...base,
            fanOut: (parent, children, closeRevision) =>
              Ref.getAndSet(failFanOut, false).pipe(
                Effect.flatMap((fail) =>
                  fail
                    ? Effect.fail(new TriggerObservationStoreError({ message: "fan-out write failed" }))
                    : base.fanOut(parent, children, closeRevision),
                ),
              ),
          }),
        },
        workflowServiceWith(fanOutDocument),
      );
      yield* observationStore.putAll([granolaAdmission]);

      assert.isTrue(Result.isFailure(yield* Effect.result(runner.execute(granolaAdmission))));
      assert.deepStrictEqual(yield* observationStore.admissions, [granolaAdmission]);
      assert.strictEqual(yield* runner.execute(granolaAdmission), "completed");
      assert.lengthOf(yield* observationStore.admissions, 2);
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("parks a lineage at hop 25 before starting a Run", () =>
    Effect.gen(function* () {
      const capped = { ...admission, lineage: { ...admission.lineage, hop: 25 } };
      const { runner, coordination, observationStore } = yield* testProgram([]);
      yield* observationStore.putAll([capped]);

      assert.strictEqual(yield* runner.execute(capped), "completed");
      assert.strictEqual((yield* Ref.get(coordination.parks))[0]?.reason._tag, "HopCap");
      assert.isEmpty(yield* (yield* RunLedger).listRuns(1));
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("runs the Granola to issue document through child routes", () =>
    Effect.gen(function* () {
      const repo: RegisteredWorkspace = {
        source: "test",
        contributions: [],
        repository: "colonylabs/cogwork",
        config: yield* Schema.decodeEffect(WorkspaceConfig)({
          name: "cogwork",
          checkoutPath: "/cogwork",
          issueTracker: { type: "github" },
        }),
      };
      const createEntry = decodeEntry("github.create-issue");
      const commentEntry = decodeEntry("github.comment-issue");
      const match = decodeNode("match");
      const newChoice = decodeNode("new");
      const duplicateChoice = decodeNode("duplicate");
      const relatedChoice = decodeNode("related");
      const actionEntry = (key: typeof createEntry, name: string, inputs: ReadonlyArray<string>) => ({
        key,
        name,
        kind: "action" as const,
        system: "github",
        connection: "github",
        requires: [],
        parameters: [],
        itemKind: null,
        actsOn: ["*"],
        requiresWorkspace: true,
        permissionProfile: "read-only" as const,
        agentInputs: inputs,
        emits: [],
      });
      const granolaDocument = WorkflowDocument.make({
        ...document,
        workspaces: { _tag: "Listed", workspaces: [repo.config.name] },
        operations: [
          {
            ...document.operations[0],
            forEach: "commitment",
            questions: [
              {
                id: match,
                text: "Match?",
                choices: [
                  { id: newChoice, name: "New" },
                  { id: duplicateChoice, name: "Duplicate" },
                  { id: relatedChoice, name: "Related" },
                ],
              },
            ],
            transitions: [
              {
                when: [{ question: match, choice: newChoice }],
                actions: [{ entry: createEntry, parameters: [] }],
                handOff: null,
              },
              ...[duplicateChoice, relatedChoice].map((choice) => ({
                when: [{ question: match, choice }],
                actions: [{ entry: commentEntry, parameters: [] }],
                handOff: null,
              })),
            ],
          },
        ],
      });
      const baseCatalogResult = yield* workflowService.catalog;
      const granolaService = {
        ...workflowServiceWith(granolaDocument),
        catalog: Effect.succeed({
          ...baseCatalogResult,
          catalog: {
            ...baseCatalogResult.catalog,
            entries: [
              ...baseCatalogResult.catalog.entries,
              actionEntry(createEntry, "Create an issue", ["issue_title", "issue_body"]),
              actionEntry(commentEntry, "Comment on an issue", ["issue", "comment"]),
            ],
          },
        }),
      } satisfies WorkflowsService;
      const writes = yield* Ref.make<ReadonlyArray<string>>([]);
      const baseTracker = yield* makeEmptyIssueTracker;
      const tracker = {
        ...baseTracker,
        createIssue: (workspace: Parameters<IssueTrackerService["createIssue"]>[0], input) =>
          Ref.modify(writes, (current) => {
            const issue = WorkItemId.make(`#${current.length + 100}`);
            return [
              WorkflowActionArtifact.make({
                workspace: workspace.config.name,
                issue,
                url: `https://example.test/issues/${issue.slice(1)}`,
                origin: input.origin,
              }),
              [...current, `create:${input.title}`],
            ];
          }),
        commentIssue: (_workspace, issue, body) =>
          Ref.update(writes, (current) => [...current, `comment:${issue}:${body}`]),
      } satisfies IssueTrackerService;
      const blankInputs = { issue_title: "", issue_body: "", issue: "", comment: "" };
      const { runner, observationStore } = yield* testProgram(
        [
          {
            summary: "Three commitments",
            stuck: false,
            elements: [
              {
                summary: "Add retries",
                answers: { match: "new" },
                inputs: { ...blankInputs, issue_title: "Add retries", issue_body: "Retry failed sends." },
                workspace: "cogwork",
              },
              {
                summary: "Document setup",
                answers: { match: "duplicate" },
                inputs: { ...blankInputs, issue: "#12", comment: "Captured in the meeting." },
                workspace: "cogwork",
              },
              {
                summary: "Expose health",
                answers: { match: "new" },
                inputs: { ...blankInputs, issue_title: "Expose health", issue_body: "Show source health." },
                workspace: "cogwork",
              },
            ],
          },
        ],
        { issueTracker: tracker, registry: { workspaces: [repo], failures: [] } },
        granolaService,
      );
      yield* observationStore.putAll([granolaAdmission]);

      yield* runner.execute(granolaAdmission);
      yield* Effect.forEach(yield* observationStore.admissions, runner.execute, { discard: true });

      assert.deepStrictEqual(yield* Ref.get(writes), [
        "create:Add retries",
        "comment:#12:Captured in the meeting.",
        "create:Expose health",
      ]);
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("freezes the complete Granola note in Work context", () =>
    Effect.gen(function* () {
      const { runner } = yield* testProgram([
        {
          summary: "Captured",
          stuck: false,
          answers: { done: "yes" },
          inputs: { notification: "Captured" },
        },
      ]);
      yield* runner.execute(granolaAdmission);
      const [run] = yield* (yield* RunLedger).listRuns(10);
      assert.isDefined(run);
      if (!run) return;
      const plan = yield* (yield* RunLedger).getRunPlan(run.id);

      assert.strictEqual(
        plan?.workContext.prose.body,
        [
          "# Weekly product sync",
          "",
          "## Attendees",
          "Taylor <taylor@example.com>",
          "Ari <ari@example.com>",
          "",
          "## Calendar event",
          "Weekly product sync · 2026-10-29 09:00 MDT",
          "",
          "## Summary",
          "Decided to ship the smaller change.",
          "",
          "## Transcript",
          "Taylor: Ship the smaller change.\nAri: Agreed.",
        ].join("\n"),
      );
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("includes artifacts already created by the lineage in Work context", () =>
    Effect.gen(function* () {
      const artifact = WorkflowActionArtifact.make({
        workspace: decodeWorkspace("cogwork"),
        issue: decodeWorkItem("#99"),
        url: "https://example.test/issues/99",
        origin: {
          item: keyOf(granolaAdmission.event.key),
          workflow,
          attempt: decodeRun("prior-run"),
          writeKey: "prior-write",
          lineage: granolaAdmission.lineage,
        },
      });
      yield* (yield* WorkflowArtifactStore).record(artifact);
      const { runner } = yield* testProgram([
        {
          summary: "Captured",
          stuck: false,
          answers: { done: "yes" },
          inputs: { notification: "Captured" },
        },
      ]);

      yield* runner.execute(granolaAdmission);
      const [run] = yield* (yield* RunLedger).listRuns(10);
      assert.isDefined(run);
      if (!run) return;
      const plan = yield* (yield* RunLedger).getRunPlan(run.id);

      assert.include(plan?.workContext.prose.body ?? "", "## Artifacts this lineage created");
      assert.include(plan?.workContext.prose.body ?? "", "https://example.test/issues/99");
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("waits for every sibling rejection before processing the source revision", () =>
    Effect.gen(function* () {
      const rejected: TriggerAdmission = {
        ...granolaAdmission,
        event: {
          ...granolaAdmission.event,
          payload: { _tag: "GranolaNoteRejected", reason: "Granola note has no transcript" },
        },
      };
      const sibling = { ...rejected, subscription: siblingGranolaAdmission.subscription };
      const { runner, coordination, observationStore } = yield* testProgram([]);
      yield* observationStore.putAll([rejected, sibling]);
      yield* runner.execute(rejected);

      assert.deepStrictEqual(yield* (yield* RunLedger).listRuns(10), []);
      assert.deepStrictEqual((yield* Ref.get(coordination.parks)).at(-1)?.reason, {
        _tag: "PlanRejected",
        reason: "Granola note has no transcript",
        entry: granolaAdmission.event.entry,
      });
      assert.isNull(yield* Ref.get(coordination.processed));

      yield* runner.execute(sibling);

      assert.strictEqual(yield* Ref.get(coordination.processed), rejected.event.revision);
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("reports a rejected Granola note as skipped", () =>
    Effect.gen(function* () {
      const rejected: TriggerAdmission = {
        ...granolaAdmission,
        event: {
          ...granolaAdmission.event,
          payload: { _tag: "GranolaNoteRejected", reason: "Granola note has no transcript" },
        },
      };
      const { runner } = yield* testProgram([]);

      assert.strictEqual(yield* runner.execute(rejected), "skipped");
      assert.deepStrictEqual(yield* (yield* RunLedger).listRuns(10), []);
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("reports a non-exhausted failure as retryable", () =>
    Effect.gen(function* () {
      const { runner, coordination, observationStore } = yield* testProgram([{}]);
      yield* observationStore.putAll([admission]);

      assert.strictEqual(yield* runner.execute(admission), "retry");
      assert.isNull(yield* Ref.get(coordination.processed));
      assert.lengthOf(yield* observationStore.admissions, 1);
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("marks a source revision processed after its last sibling Workflow admission", () =>
    Effect.gen(function* () {
      const siblingAdmission = {
        ...admission,
        subscription: { ...admission.subscription, workflow: siblingWorkflow },
      } satisfies TriggerAdmission;
      const { runner, coordination, observationStore } = yield* testProgram([
        {
          summary: "First complete",
          stuck: false,
          answers: { done: "yes" },
          inputs: { notification: "First complete" },
        },
        {
          summary: "Second complete",
          stuck: false,
          answers: { done: "yes" },
          inputs: { notification: "Second complete" },
        },
      ]);
      yield* observationStore.putAll([admission, siblingAdmission]);

      yield* runner.execute(admission);
      assert.isNull(yield* Ref.get(coordination.processed));

      yield* runner.execute(siblingAdmission);
      assert.strictEqual(yield* Ref.get(coordination.processed), "1000");
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("marks a source revision processed when sibling completions overlap", () =>
    Effect.gen(function* () {
      const siblingAdmission = {
        ...admission,
        subscription: { ...admission.subscription, workflow: siblingWorkflow },
      } satisfies TriggerAdmission;
      const readers = yield* Ref.make(0);
      const bothReading = yield* Deferred.make<void>();
      const { runner, coordination, observationStore } = yield* testProgram(
        [
          {
            summary: "First complete",
            stuck: false,
            answers: { done: "yes" },
            inputs: { notification: "First complete" },
          },
          {
            summary: "Second complete",
            stuck: false,
            answers: { done: "yes" },
            inputs: { notification: "Second complete" },
          },
        ],
        {
          observationStore: (service) => ({
            ...service,
            complete: (...args) =>
              Ref.updateAndGet(readers, (count) => count + 1).pipe(
                Effect.flatMap((count) =>
                  count === 2 ? Deferred.succeed(bothReading, undefined) : Deferred.await(bothReading),
                ),
                Effect.andThen(service.complete(...args)),
              ),
          }),
        },
      );
      yield* observationStore.putAll([admission, siblingAdmission]);

      yield* Effect.all([runner.execute(admission), runner.execute(siblingAdmission)], {
        concurrency: "unbounded",
        discard: true,
      });

      assert.strictEqual(yield* Ref.get(coordination.processed), "1000");
      assert.deepStrictEqual(yield* observationStore.admissions, []);
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("keeps the last admission pending when source completion fails", () =>
    Effect.gen(function* () {
      const { runner, observationStore } = yield* testProgram(
        [
          {
            summary: "Complete",
            stuck: false,
            answers: { done: "yes" },
            inputs: { notification: "Complete" },
          },
        ],
        {
          coordination: (service) => ({
            ...service,
            markProcessed: () =>
              Effect.fail(
                new CoordinationError({
                  reason: "unavailable",
                  retryable: true,
                  message: "Control store unavailable",
                }),
              ),
          }),
        },
      );
      yield* observationStore.putAll([admission]);

      const result = yield* Effect.result(runner.execute(admission));

      assert.isTrue(Result.isFailure(result));
      assert.deepStrictEqual(yield* observationStore.admissions, [admission]);
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("keeps a source revision pending after a non-exhausted Workflow failure", () =>
    Effect.gen(function* () {
      const { runner, coordination, observationStore } = yield* testProgram([], {
        run: () =>
          Stream.fail(
            new HarnessError({
              reason: "turn",
              retryable: true,
              message: "Harness failed",
            }),
          ),
      });
      yield* observationStore.putAll([admission]);

      const outcome = yield* runner.execute(admission);

      assert.strictEqual(outcome, "retry");
      assert.isNull(yield* Ref.get(coordination.processed));
      assert.deepStrictEqual(yield* observationStore.admissions, [admission]);
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("writes frozen Notify me text and keeps the Run workspace-free", () =>
    Effect.gen(function* () {
      const { runner } = yield* testProgram([
        {
          summary: "All clear",
          stuck: false,
          answers: { done: "yes" },
          inputs: { notification: "Deploy ready" },
        },
      ]);
      yield* runner.execute(admission);
      const ledger = yield* RunLedger;
      const [run] = yield* ledger.listRuns(10);
      assert.isDefined(run);
      if (!run) return;
      const plan = yield* ledger.getRunPlan(run.id);
      const activities = yield* (yield* RunRecorder).replay(run).pipe(Stream.runCollect);
      const actionPlan = activities.find(
        ({ event }) => event.type === "CUSTOM" && event.name === "workflow.action-plan",
      );
      const frozenPlan = yield* Schema.decodeUnknownEffect(Schema.Struct({ object: WorkflowActionPlan }))(
        actionPlan?.event.value,
      ).pipe(Effect.map(({ object }) => object));
      yield* Effect.forEach(
        Array.from({ length: 101 }, (_, index) => index),
        (index) =>
          ledger.insertRun({
            ...run,
            id: decodeRun(`noise-${index}`),
            startedAtMillis: run.startedAtMillis + index + 1,
          }),
        { discard: true },
      );
      const restartedNotifications = yield* makeNotifications;

      assert.strictEqual(run.status, "succeeded");
      assert.isNull(plan?.sandbox.workspace);
      assert.isEmpty(plan?.tools ?? []);
      assert.isDefined(actionPlan);
      assert.strictEqual(frozenPlan.steps[0]?.entry, notifyEntry);
      assert.deepStrictEqual(frozenPlan.steps[0]?.inputs, { notification: "Deploy ready" });
      assert.strictEqual(plan?.workContext.prose.body, admission.event.workContext?.body);
      assert.deepStrictEqual(
        plan?.workContext.prose.comments.map((comment) => ({ ...comment })),
        admission.event.workContext?.comments,
      );
      assert.strictEqual(
        plan?.instructions.find(({ source }) => source === "workflow-operation")?.content,
        "implement-agent:Summarize the day.",
      );
      assert.deepStrictEqual(
        (yield* restartedNotifications.list).map(({ summary, answers }) => ({ summary, answers })),
        [{ summary: "Deploy ready", answers: { done: "yes" } }],
      );
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("adds issue search only when a Transition writes an issue", () =>
    Effect.gen(function* () {
      const createIssueEntry = decodeEntry("github.create-issue");
      const issueDocument = WorkflowDocument.make({
        ...document,
        operations: document.operations.map((candidate) => ({
          ...candidate,
          transitions: candidate.transitions.map((candidateTransition) => ({
            ...candidateTransition,
            actions: [{ entry: createIssueEntry, parameters: [] }],
          })),
        })),
      });
      const baseCatalogResult = yield* workflowService.catalog;
      const issueService = {
        ...workflowServiceWith(issueDocument),
        catalog: Effect.succeed({
          ...baseCatalogResult,
          catalog: {
            ...baseCatalogResult.catalog,
            entries: [
              ...baseCatalogResult.catalog.entries,
              {
                key: createIssueEntry,
                name: "Create an issue",
                kind: "action" as const,
                system: "github",
                connection: "github",
                requires: [],
                parameters: [],
                itemKind: null,
                actsOn: ["*"],
                requiresWorkspace: true,
                permissionProfile: "read-only" as const,
                agentInputs: ["issue_title", "issue_body"],
                emits: [],
              },
            ],
          },
        }),
      } satisfies WorkflowsService;
      const { runner } = yield* testProgram(
        [
          {
            summary: "Create it",
            stuck: false,
            answers: { done: "yes" },
            inputs: { issue_title: "Title", issue_body: "Body" },
            workspace: "none",
          },
        ],
        {},
        issueService,
      );

      yield* runner.execute(admission);
      const [run] = yield* (yield* RunLedger).listRuns(1);
      assert.isDefined(run);
      if (!run) return;
      const plan = yield* (yield* RunLedger).getRunPlan(run.id);

      assert.deepStrictEqual(plan?.tools, ["issue-search"]);
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("refuses a matched action input that is empty after trim", () =>
    Effect.gen(function* () {
      const { runner, coordination } = yield* testProgram([
        {
          summary: "No message",
          stuck: false,
          answers: { done: "yes" },
          inputs: { notification: "   " },
        },
      ]);
      yield* runner.execute(admission);
      const [run] = yield* (yield* RunLedger).listRuns(10);
      const attempts = yield* Ref.get(coordination.attempts);

      assert.strictEqual(run?.status, "failed");
      assert.include(attempts[0]?.reason ?? "", "needs non-empty input notification");
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("refuses approval when the displayed plan digest is stale", () =>
    Effect.gen(function* () {
      const waitingDocument = yield* documentWithTransition({
        when: [{ question: decodeNode("done"), choice: decodeNode("yes") }],
        actions: [
          { entry: waitForApprovalEntry, parameters: [] },
          { entry: notifyEntry, parameters: [] },
        ],
        handOff: null,
      });
      const { runner, notifications, observationStore } = yield* testProgram(
        [
          {
            summary: "Ready",
            stuck: false,
            answers: { done: "yes" },
            inputs: { approval_request: "Run this plan", notification: "Original" },
          },
        ],
        {},
        workflowServiceFor(waitingDocument, [waitForApprovalCatalogEntry]),
      );
      yield* observationStore.putAll([admission]);
      yield* runner.execute(admission);
      const plan = yield* (yield* WorkflowActionPlanStore).pending(keyOf(admission.event.key), workflow);
      assert.isNotNull(plan);
      if (plan === null) return;

      const failure = yield* Effect.flip(
        runner.approve({ item: admission.event.key, attempt: plan.attempt, digest: "stale-digest" }),
      );

      assert.strictEqual(failure.reason, "stale-digest");
      assert.isEmpty(yield* notifications.list);
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("refuses approval after the source revision advances", () =>
    Effect.gen(function* () {
      const waitingDocument = yield* documentWithTransition({
        when: [{ question: decodeNode("done"), choice: decodeNode("yes") }],
        actions: [{ entry: waitForApprovalEntry, parameters: [] }],
        handOff: null,
      });
      const { runner, coordination, observationStore } = yield* testProgram(
        [
          {
            summary: "Ready",
            stuck: false,
            answers: { done: "yes" },
            inputs: { approval_request: "Run this plan" },
          },
        ],
        {},
        workflowServiceFor(waitingDocument, [waitForApprovalCatalogEntry]),
      );
      yield* observationStore.putAll([admission]);
      yield* runner.execute(admission);
      const plan = yield* (yield* WorkflowActionPlanStore).pending(keyOf(admission.event.key), workflow);
      assert.isNotNull(plan);
      if (plan === null) return;
      yield* Ref.set(coordination.observed, "1001");

      const failure = yield* Effect.flip(
        runner.approve({ item: admission.event.key, attempt: plan.attempt, digest: plan.digest }),
      );

      assert.strictEqual(failure.reason, "stale-attempt");
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("refuses edited approval after the published Workflow changes", () =>
    Effect.gen(function* () {
      const waitingDocument = yield* documentWithTransition({
        when: [{ question: decodeNode("done"), choice: decodeNode("yes") }],
        actions: [
          { entry: waitForApprovalEntry, parameters: [] },
          { entry: notifyEntry, parameters: [] },
        ],
        handOff: null,
      });
      const publishedRevision = yield* Ref.make(1);
      const baseService = workflowServiceFor(waitingDocument, [waitForApprovalCatalogEntry]);
      const service: WorkflowsService = {
        ...baseService,
        get: () =>
          Ref.get(publishedRevision).pipe(
            Effect.map((revision) => ({
              ...workflowRecord,
              workingCopy: waitingDocument,
              workingRevision: revision,
              publishedCopy: waitingDocument,
              publishedRevision: revision,
            })),
          ),
      };
      const { runner, observationStore } = yield* testProgram(
        [
          {
            summary: "Ready",
            stuck: false,
            answers: { done: "yes" },
            inputs: { approval_request: "Run this plan", notification: "Original" },
          },
        ],
        {},
        service,
      );
      yield* observationStore.putAll([admission]);
      yield* runner.execute(admission);
      const plan = yield* (yield* WorkflowActionPlanStore).pending(keyOf(admission.event.key), workflow);
      assert.isNotNull(plan);
      if (plan === null) return;
      yield* Ref.set(publishedRevision, 2);

      const failure = yield* Effect.flip(
        runner.approve({
          item: admission.event.key,
          attempt: plan.attempt,
          digest: plan.digest,
          edits: { notification: "Edited" },
        }),
      );

      assert.strictEqual(failure.reason, "stale-digest");
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("returns the rebuilt approval digest and dismisses its notification", () =>
    Effect.gen(function* () {
      const waitingDocument = yield* documentWithTransition({
        when: [{ question: decodeNode("done"), choice: decodeNode("yes") }],
        actions: [
          { entry: waitForApprovalEntry, parameters: [] },
          { entry: notifyEntry, parameters: [] },
        ],
        handOff: null,
      });
      const { runner, notifications, observationStore } = yield* testProgram(
        [
          {
            summary: "Ready",
            stuck: false,
            answers: { done: "yes" },
            inputs: { approval_request: "Run this plan", notification: "Original" },
          },
        ],
        {},
        workflowServiceFor(waitingDocument, [waitForApprovalCatalogEntry]),
      );
      yield* observationStore.putAll([admission]);
      yield* runner.execute(admission);
      const plan = yield* (yield* WorkflowActionPlanStore).pending(keyOf(admission.event.key), workflow);
      assert.isNotNull(plan);
      if (plan === null) return;

      const approvedDigest = yield* runner.approve({
        item: admission.event.key,
        attempt: plan.attempt,
        digest: plan.digest,
        edits: { notification: "Edited" },
      });

      const [notification] = yield* notifications.list;
      assert.deepInclude(notification, { summary: "Edited", item: admission.event.key });
      assert.include(notification?.id, keyOf(admission.event.key));
      assert.include(notification?.id, plan.attempt);
      assert.notStrictEqual(approvedDigest, plan.digest);
      assert.isNull(yield* (yield* WorkflowActionPlanStore).pending(keyOf(admission.event.key), workflow));
      const run = yield* (yield* RunLedger).getRun(plan.attempt);
      assert.isNotNull(run);
      if (run === null) return;
      const approval = (yield* (yield* RunRecorder).replay(run).pipe(Stream.runCollect)).find(
        ({ event }) => event.type === "CUSTOM" && event.name === "workflow.plan-approved",
      );
      const approvalValue = approval?.event.type === "CUSTOM" ? approval.event.value : undefined;
      assert.strictEqual(decodeDecisionValue(approvalValue).object.digest, approvedDigest);
      assert.isDefined(notification);
      if (!notification) return;
      yield* notifications.dismiss(notification.id);
      assert.isEmpty(yield* notifications.list);
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("rejects an approval plan as Stop and records the person's note", () =>
    Effect.gen(function* () {
      const waitingDocument = yield* documentWithTransition({
        when: [{ question: decodeNode("done"), choice: decodeNode("yes") }],
        actions: [{ entry: waitForApprovalEntry, parameters: [] }],
        handOff: null,
      });
      const { runner, observationStore } = yield* testProgram(
        [
          {
            summary: "Ready",
            stuck: false,
            answers: { done: "yes" },
            inputs: { approval_request: "Run this plan" },
          },
        ],
        {},
        workflowServiceFor(waitingDocument, [waitForApprovalCatalogEntry]),
      );
      yield* observationStore.putAll([admission]);
      yield* runner.execute(admission);
      const plan = yield* (yield* WorkflowActionPlanStore).pending(keyOf(admission.event.key), workflow);
      assert.isNotNull(plan);
      if (plan === null) return;

      yield* runner.reject({
        item: admission.event.key,
        attempt: plan.attempt,
        note: "The source is no longer relevant",
      });

      assert.isNull(yield* (yield* WorkflowActionPlanStore).pending(keyOf(admission.event.key), workflow));
      assert.isEmpty(yield* observationStore.admissions);
      const run = yield* (yield* RunLedger).getRun(plan.attempt);
      assert.isNotNull(run);
      if (run === null) return;
      const rejection = (yield* (yield* RunRecorder).replay(run).pipe(Stream.runCollect)).find(
        ({ event }) => event.type === "CUSTOM" && event.name === "workflow.plan-rejected",
      );
      const rejectionValue = rejection?.event.type === "CUSTOM" ? rejection.event.value : undefined;
      assert.deepInclude(decodeDecisionValue(rejectionValue).object, {
        note: "The source is no longer relevant",
      });
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("runs a hand-off after the first action plan completes", () =>
    Effect.gen(function* () {
      const publish = decodeNode("publish");
      const [summarize] = document.operations;
      assert.isDefined(summarize);
      if (!summarize) return;
      const handedOffDocument = yield* Schema.decodeEffect(WorkflowDocument)({
        ...document,
        operations: [
          {
            ...summarize,
            transitions: [
              {
                when: [{ question: decodeNode("done"), choice: decodeNode("yes") }],
                actions: [],
                handOff: publish,
              },
            ],
          },
          {
            ...summarize,
            id: publish,
            name: "Publish",
          },
        ],
      });
      const handedOffService: WorkflowsService = {
        ...workflowService,
        get: () =>
          Effect.succeed({
            ...workflowRecord,
            workingCopy: handedOffDocument,
            publishedCopy: handedOffDocument,
          }),
      };
      const { runner, notifications } = yield* testProgram(
        [
          { summary: "Ready", stuck: false, answers: { done: "yes" }, inputs: {} },
          {
            summary: "Published",
            stuck: false,
            answers: { done: "yes" },
            inputs: { notification: "Published" },
          },
        ],
        {},
        handedOffService,
      );

      yield* runner.execute(admission);

      const runs = yield* (yield* RunLedger).listRuns(10);
      assert.lengthOf(runs, 2);
      assert.deepInclude((yield* notifications.list)[0], {
        operation: publish,
        summary: "Published",
      });
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("settles a hand-to-me Run and retains its plan for Choose an answer", () =>
    Effect.gen(function* () {
      const [summarize] = document.operations;
      assert.isDefined(summarize);
      if (!summarize) return;
      const handedDocument = yield* Schema.decodeEffect(WorkflowDocument)({
        ...document,
        operations: [
          {
            ...summarize,
            transitions: [
              {
                when: [{ question: decodeNode("done"), choice: decodeNode("yes") }],
                actions: [{ entry: handToMeEntry, parameters: [] }],
                handOff: null,
              },
            ],
          },
        ],
      });
      const handedService: WorkflowsService = {
        ...workflowService,
        get: () =>
          Effect.succeed({
            ...workflowRecord,
            workingCopy: handedDocument,
            publishedCopy: handedDocument,
          }),
      };
      const { runner, coordination } = yield* testProgram(
        [
          {
            summary: "Needs your review",
            stuck: false,
            answers: { done: "yes" },
            inputs: { hand_off: "Please review" },
          },
        ],
        {},
        handedService,
      );

      yield* runner.execute(admission);

      const [run] = yield* (yield* RunLedger).listRuns(10);
      const pending = yield* (yield* WorkflowActionPlanStore).pending(keyOf(admission.event.key), workflow);
      assert.strictEqual(run?.status, "succeeded");
      assert.strictEqual(pending?.attempt, run?.id);
      assert.strictEqual((yield* Ref.get(coordination.parks)).at(-1)?.reason._tag, "HandedToYou");
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("runs the chosen answer through the frozen plan executor", () =>
    Effect.gen(function* () {
      const [summarize] = document.operations;
      assert.isDefined(summarize);
      if (summarize === undefined) return;
      const handedDocument = yield* Schema.decodeEffect(WorkflowDocument)({
        ...document,
        operations: [
          {
            ...summarize,
            questions: [
              {
                id: decodeNode("done"),
                text: "Done?",
                choices: [
                  { id: decodeNode("yes"), name: "Yes" },
                  { id: decodeNode("no"), name: "No" },
                ],
              },
            ],
            transitions: [
              {
                when: [{ question: decodeNode("done"), choice: decodeNode("yes") }],
                actions: [{ entry: handToMeEntry, parameters: [] }],
                handOff: null,
              },
              {
                when: [{ question: decodeNode("done"), choice: decodeNode("no") }],
                actions: [{ entry: notifyEntry, parameters: [] }],
                handOff: null,
              },
            ],
          },
        ],
      });
      const { runner, notifications, observationStore } = yield* testProgram(
        [
          {
            summary: "Needs your answer",
            stuck: false,
            answers: { done: "yes" },
            inputs: { hand_off: "Choose", notification: "Agent default" },
          },
        ],
        {},
        workflowServiceFor(handedDocument),
      );
      yield* observationStore.putAll([admission]);
      yield* runner.execute(admission);
      const plan = yield* (yield* WorkflowActionPlanStore).pending(keyOf(admission.event.key), workflow);
      assert.isNotNull(plan);
      if (plan === null) return;

      const stale = yield* Effect.flip(
        runner.chooseAnswer({
          item: admission.event.key,
          attempt: decodeRun("stale-attempt"),
          answers: { done: "no" },
          inputs: { notification: "Ignored" },
        }),
      );
      assert.strictEqual(stale.reason, "stale-attempt");

      const invalid = yield* Effect.flip(
        runner.chooseAnswer({
          item: admission.event.key,
          attempt: plan.attempt,
          answers: { done: "later" },
          inputs: { notification: "Ignored" },
        }),
      );
      assert.strictEqual(invalid.reason, "invalid-edits");

      yield* runner.chooseAnswer({
        item: admission.event.key,
        attempt: plan.attempt,
        answers: { done: "no" },
        inputs: { notification: "Person chose no" },
      });

      assert.deepInclude((yield* notifications.list)[0], { summary: "Person chose no" });
      assert.isNull(yield* (yield* WorkflowActionPlanStore).pending(keyOf(admission.event.key), workflow));
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("replans the frozen operation after handback and interrupts its prior Run", () =>
    Effect.gen(function* () {
      const publish = decodeNode("publish");
      const [summarize] = document.operations;
      assert.isDefined(summarize);
      if (!summarize) return;
      const replannedDocument = yield* Schema.decodeEffect(WorkflowDocument)({
        ...document,
        operations: [...document.operations, { ...summarize, id: publish, name: "Publish" }],
      });
      const replannedService: WorkflowsService = {
        ...workflowService,
        get: () =>
          Effect.succeed({
            ...workflowRecord,
            workingCopy: replannedDocument,
            publishedCopy: replannedDocument,
          }),
      };
      const { runner, coordination, notifications } = yield* testProgram(
        [
          {
            summary: "Published",
            stuck: false,
            answers: { done: "yes" },
            inputs: { notification: "Published" },
          },
        ],
        {},
        replannedService,
      );
      const pending = WorkflowActionPlan.make({
        item: keyOf(admission.event.key),
        workflow,
        attempt: decodeRun("publish-plan"),
        operation: publish,
        revision: admission.event.revision,
        createdAtMillis: 1,
        consumedHandbackAtMillis: 0,
        digest: "publish-plan",
        summary: "Waiting for a Workspace",
        answers: {},
        lineage: admission.lineage,
        handOff: null,
        steps: [
          WorkflowActionPlanStep.make({
            position: 0,
            entry: notifyEntry,
            parameters: [],
            inputs: { notification: "stale" },
            target: { _tag: "NoWorkspace" },
            writeKey: "publish-plan:0",
            status: "pending",
            failures: 0,
            artifact: null,
          }),
        ],
      });
      const ledger = yield* RunLedger;
      const priorSession = decodeSession("publish-session");
      yield* ledger.insertSession({
        kind: "owned-transcript",
        id: priorSession,
        workspace: decodeWorkspace(workflow),
        harness: harnessName,
        createdAtMillis: 1,
      });
      yield* ledger.insertRun({
        id: pending.attempt,
        workspace: decodeWorkspace(workflow),
        workItem: decodeWorkItem(keyOf(admission.event.key)),
        stage: "implement",
        harness: harnessName,
        branch: null,
        session: priorSession,
        usage: null,
        status: "running",
        startedAtMillis: 1,
        endedAtMillis: null,
      });
      yield* (yield* WorkflowActionPlanStore).create(pending);
      yield* coordination.service.handBack(admission.event.key, {
        by: "Taylor",
        note: "Use the repaired Workspace",
      });

      yield* runner.execute(admission);

      assert.deepInclude((yield* notifications.list)[0], {
        operation: publish,
        summary: "Published",
      });
      assert.deepInclude(yield* ledger.getRun(pending.attempt), {
        status: "interrupted",
        endedAtMillis: 0,
      });
      const resumed = (yield* ledger.listRuns(10)).find(({ id }) => id !== pending.attempt);
      assert.strictEqual(resumed?.session, priorSession);
      const resumedPlan = resumed === undefined ? null : yield* ledger.getRunPlan(resumed.id);
      assert.include(resumedPlan?.messages[0]?.content ?? "", "Person's note: Use the repaired Workspace");
      assert.strictEqual(yield* Ref.get(coordination.claims), 1);
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("resumes a stuck Operation session with the person's note", () =>
    Effect.gen(function* () {
      const { runner, coordination } = yield* testProgram([
        {
          summary: "Needs a decision",
          stuck: true,
          answers: { done: "yes" },
          inputs: { notification: "Wait" },
        },
        {
          summary: "Recovered",
          stuck: false,
          answers: { done: "yes" },
          inputs: { notification: "Recovered" },
        },
      ]);
      const ledger = yield* RunLedger;
      yield* runner.execute(admission);
      const [parked] = yield* ledger.listRuns(10);
      assert.isDefined(parked);
      if (parked === undefined) return;
      assert.lengthOf(yield* Ref.get(coordination.parks), 1);
      assert.isNotNull((yield* coordination.service.read(admission.event.key)).park);

      yield* runner.handBack({ item: admission.event.key, note: "Use the human decision" });
      yield* runner.execute(admission);

      const resumed = (yield* ledger.listRuns(10)).find(({ id }) => id !== parked.id);
      assert.strictEqual(resumed?.session, parked.session);
      const resumedPlan = resumed === undefined ? null : yield* ledger.getRunPlan(resumed.id);
      assert.include(resumedPlan?.messages[0]?.content ?? "", "Person's note: Use the human decision");
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("refuses handback without an active park", () =>
    Effect.gen(function* () {
      const { runner } = yield* testProgram([]);

      const failure = yield* Effect.flip(runner.handBack({ item: admission.event.key }));

      assert.strictEqual(failure.reason, "not-found");
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("reruns the operation when handback overtakes a new approval plan", () =>
    Effect.gen(function* () {
      const [summarize] = document.operations;
      assert.isDefined(summarize);
      if (!summarize) return;
      const waitingDocument = yield* Schema.decodeEffect(WorkflowDocument)({
        ...document,
        operations: [
          {
            ...summarize,
            transitions: [
              {
                when: [{ question: decodeNode("done"), choice: decodeNode("yes") }],
                actions: [{ entry: waitForApprovalEntry, parameters: [] }],
                handOff: null,
              },
            ],
          },
        ],
      });
      const waitingService: WorkflowsService = {
        ...workflowService,
        get: () =>
          Effect.succeed({
            ...workflowRecord,
            workingCopy: waitingDocument,
            publishedCopy: waitingDocument,
          }),
        catalog: workflowService.catalog.pipe(
          Effect.map((result) => ({
            ...result,
            catalog: {
              ...result.catalog,
              entries: [
                ...result.catalog.entries,
                {
                  key: waitForApprovalEntry,
                  name: "Wait for my approval",
                  kind: "action",
                  system: null,
                  connection: null,
                  requires: [],
                  parameters: [],
                  itemKind: null,
                  actsOn: ["*"],
                  requiresWorkspace: false,
                  permissionProfile: "read-only",
                  agentInputs: ["approval_request"],
                  emits: [],
                },
              ],
            },
          })),
        ),
      };
      const coordinationReads = yield* Ref.make(0);
      const { runner } = yield* testProgram(
        [
          {
            summary: "First plan",
            stuck: false,
            answers: { done: "yes" },
            inputs: { approval_request: "Approve the first plan" },
          },
          {
            summary: "Second plan",
            stuck: false,
            answers: { done: "yes" },
            inputs: { approval_request: "Approve the second plan" },
          },
        ],
        {
          coordination: (service) => ({
            ...service,
            read: (...args) =>
              Ref.updateAndGet(coordinationReads, (count) => count + 1).pipe(
                Effect.flatMap((count) =>
                  count === 3
                    ? service
                        .handBack(admission.event.key, { by: "Taylor" })
                        .pipe(
                          Effect.andThen(TestClock.adjust("2001 millis")),
                          Effect.andThen(service.read(...args)),
                        )
                    : service.read(...args),
                ),
              ),
          }),
        },
        waitingService,
      );

      yield* runner.execute(admission);

      const runs = yield* (yield* RunLedger).listRuns(10);
      assert.lengthOf(runs, 2);
      assert.lengthOf(
        runs.filter(({ status }) => status === "interrupted"),
        1,
      );
      assert.lengthOf(
        runs.filter(({ status }) => status === "succeeded"),
        1,
      );
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("interrupts the Run for a plan withdrawn by a new source revision", () =>
    Effect.gen(function* () {
      const staleAttempt = decodeRun("stale-plan");
      const stalePlan = WorkflowActionPlan.make({
        item: keyOf(admission.event.key),
        workflow,
        attempt: staleAttempt,
        operation,
        revision: "999",
        createdAtMillis: 1,
        consumedHandbackAtMillis: 0,
        digest: "stale-plan",
        summary: "Stale plan",
        answers: {},
        lineage: admission.lineage,
        handOff: null,
        steps: [],
      });
      const ledger = yield* RunLedger;
      yield* ledger.insertRun({
        id: staleAttempt,
        workspace: decodeWorkspace(workflow),
        workItem: decodeWorkItem(keyOf(admission.event.key)),
        stage: "implement",
        harness: harnessName,
        branch: null,
        session: null,
        usage: null,
        status: "running",
        startedAtMillis: 1,
        endedAtMillis: null,
      });
      yield* (yield* WorkflowActionPlanStore).create(stalePlan);
      const { runner } = yield* testProgram([
        {
          summary: "Current plan",
          stuck: false,
          answers: { done: "yes" },
          inputs: { notification: "Current plan" },
        },
      ]);

      yield* runner.execute(admission);

      assert.deepInclude(yield* ledger.getRun(staleAttempt), {
        status: "interrupted",
        endedAtMillis: 0,
      });
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("parks the item after three invalid results", () =>
    Effect.gen(function* () {
      const { runner, coordination } = yield* testProgram([{}, {}, {}]);
      yield* runner.execute(admission);
      yield* runner.execute(admission);
      yield* runner.execute(admission);

      assert.lengthOf(yield* Ref.get(coordination.attempts), 3);
      assert.strictEqual((yield* Ref.get(coordination.parks)).at(-1)?.reason._tag, "Exhausted");
      assert.isNull(yield* Ref.get(coordination.processed));
      const ledger = yield* RunLedger;
      const plans = yield* Effect.forEach(yield* ledger.listRuns(10), ({ id }) => ledger.getRunPlan(id));
      assert.isTrue(
        plans.some((plan) =>
          plan?.operatingInstructions.resources.some(({ source }) => source === "previous-result-issues"),
        ),
      );
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("parks a stuck result without blocking a sibling Workflow", () =>
    Effect.gen(function* () {
      const siblingAdmission = {
        ...admission,
        subscription: { ...admission.subscription, workflow: siblingWorkflow },
      } satisfies TriggerAdmission;
      const { runner, coordination, observationStore } = yield* testProgram([
        {
          summary: "Needs a decision",
          stuck: true,
          answers: { done: "yes" },
          inputs: { notification: "Needs a decision" },
        },
      ]);
      yield* observationStore.putAll([admission, siblingAdmission]);
      yield* runner.execute(admission);

      assert.lengthOf(yield* Ref.get(coordination.attempts), 1);
      assert.strictEqual((yield* Ref.get(coordination.parks)).at(-1)?.reason._tag, "Stuck");
      assert.isNull(yield* Ref.get(coordination.processed));
      assert.strictEqual(
        (yield* coordination.service.read(admission.event.key)).gate({ workflow: siblingWorkflow, operation })
          ._tag,
        "Open",
      );
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("declines before creating a Run when Harness preflight fails", () =>
    Effect.gen(function* () {
      const { runner, coordination } = yield* testProgram([], {
        preflight: () =>
          Effect.fail(
            new HarnessError({
              reason: "credential",
              retryable: true,
              message: "Harness unavailable",
            }),
          ),
        run: () => Stream.die("unexpected Harness run"),
      });
      yield* runner.execute(admission);

      assert.deepStrictEqual(yield* (yield* RunLedger).listRuns(10), []);
      assert.strictEqual((yield* Ref.get(coordination.parks)).at(-1)?.reason._tag, "MissingOperation");
      assert.isNull(yield* Ref.get(coordination.processed));
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("records a failed terminal event when a Workflow Run times out", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const { runner } = yield* testProgram([], {
        run: () =>
          Stream.fromEffect(Deferred.succeed(started, undefined)).pipe(Stream.flatMap(() => Stream.never)),
      });
      const running = yield* Effect.forkChild(runner.execute(admission), { startImmediately: true });
      yield* Deferred.await(started);
      yield* TestClock.adjust(defaultRunBudget("read-only"));
      yield* Fiber.join(running);

      const ledger = yield* RunLedger;
      const [run] = yield* ledger.listRuns(10);
      assert.isDefined(run);
      if (!run) return;
      const recorder = yield* RunRecorder;
      const activities = yield* recorder.replay(run).pipe(Stream.runCollect);

      assert.deepInclude(
        activities.map(({ event }) => event),
        { type: "RUN_FINISHED", finishReason: "failed" },
      );
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );
});
