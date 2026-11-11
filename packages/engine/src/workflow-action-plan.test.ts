import {
  BranchName,
  HarnessName,
  keyOf,
  type ParkReason,
  RunId,
  SlackChannelId,
  SlackMessageTs,
  SlackTeamId,
  SourceControlType,
  WorkflowActionArtifact,
  WorkflowActionPlan,
  WorkflowActionPlanStep,
  WorkflowActionTarget,
  WorkflowCatalogKey,
  WorkflowDocument,
  WorkflowId,
  WorkflowNodeId,
  WorkItemId,
  WorkspaceConfig,
} from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { Coordination, type CoordinationService, fold } from "./coordination";
import { GitError } from "./git";
import { githubSourceControlActionEntries } from "./github/provider";
import { IssueTracker, IssueTrackerError, makeEmpty } from "./issue-tracker";
import type { RegisteredWorkspace } from "./projector";
import { emptyRegistry, readOnlyRegistry, WorkspaceRegistry } from "./registry";
import { RunLedger } from "./run-ledger";
import { SlackWrite, SlackWriteError, slackActionEntries } from "./slack-write";
import { emptyService as emptySourceControl, SourceControlProvider } from "./source-control";
import { engineTestLayer } from "./testing/engine-test-layer";
import {
  makeMemoryTriggerObservationStore,
  type TriggerAdmission,
  TriggerObservationStore,
} from "./trigger-observation";
import { buildWorkflowActionPlan, executeWorkflowActionPlan } from "./workflow-action-plan";
import {
  WorkflowActionPlanStore,
  memoryLayer as workflowActionPlanStoreLayer,
} from "./workflow-action-plan-store";
import { memoryLayer as workflowArtifactStoreLayer } from "./workflow-artifact-store";
import { PullRequestReadiness, WorktreeManager } from "./worktree";

const decodeWorkflow = Schema.decodeSync(WorkflowId);
const decodeNode = Schema.decodeSync(WorkflowNodeId);
const decodeRun = Schema.decodeSync(RunId);
const decodeItem = Schema.decodeSync(WorkItemId);
const decodeSlackTarget = Schema.decodeSync(WorkflowActionTarget);
const decodeSlackChannel = Schema.decodeSync(SlackChannelId);
const decodeSlackTs = Schema.decodeSync(SlackMessageTs);
const slackTeam = Schema.decodeSync(SlackTeamId)("T123");
const decodeEntry = Schema.decodeSync(WorkflowCatalogKey);
const decodeHarness = Schema.decodeSync(HarnessName);
const decodeBranch = Schema.decodeSync(BranchName);
const workflow = decodeWorkflow("issue-writes");
const operation = decodeNode("write");
const trigger = decodeNode("issue-changed");
const workspace: RegisteredWorkspace = {
  source: "control-store:workspace",
  contributions: [],
  config: Schema.decodeSync(WorkspaceConfig)({
    name: "repo",
    checkoutPath: "/repo",
    issueTracker: { type: "github" },
  }),
};
const item = decodeItem("#811");
const linearConfig = Schema.decodeSync(WorkspaceConfig)({
  name: "linear",
  checkoutPath: "/linear",
  issueTracker: { type: "linear", teams: ["CGW"] },
});
const ref = { _tag: "Issue", workspace: workspace.config.name, id: item } as const;
const admission: TriggerAdmission = {
  event: {
    key: ref,
    revision: "1",
    cause: { _tag: "Unknown" },
    atMillis: 1,
    entry: decodeEntry("github.issue-changed"),
    workspace: workspace.config.name,
  },
  subscription: {
    workflow,
    trigger,
    operation,
    entry: decodeEntry("github.issue-changed"),
    parameters: [],
    filters: [],
    workspaces: [workspace.config.name],
    catchUp: { since: 0 },
  },
  lineage: {
    root: Schema.decodeSync(Schema.String.pipe(Schema.brand("LineageId")))(keyOf(ref)),
    parent: null,
    hop: 0,
  },
};

const slackRef = { _tag: "SlackMessage", team: "T123", channel: "C123", ts: "900.000" } as const;
const slackAdmission: TriggerAdmission = {
  ...admission,
  event: {
    ...admission.event,
    key: slackRef,
    entry: decodeEntry("slack.i-am-mentioned"),
    workspace: null,
  },
};

const plan = (steps: ReadonlyArray<WorkflowActionPlanStep>) =>
  WorkflowActionPlan.make({
    item: keyOf(ref),
    workflow,
    attempt: decodeRun("plan-attempt"),
    operation,
    revision: "1",
    createdAtMillis: 10,
    consumedHandbackAtMillis: 0,
    digest: "plan-digest",
    summary: "write",
    answers: {},
    lineage: admission.lineage,
    handOff: null,
    steps,
  });

const step = (position: number, entry: string, comment = "") =>
  WorkflowActionPlanStep.make({
    position,
    entry: decodeEntry(entry),
    parameters: [],
    inputs: comment === "" ? {} : { comment },
    target: {
      _tag: "CurrentIssue",
      workspace: workspace.config.name,
      app: workspace.config.issueTracker.type,
      issueTracker: workspace.config.issueTracker,
      repository: null,
      issue: item,
    },
    writeKey: `write-${position}`,
    status: "pending",
    failures: 0,
    artifact: null,
  });

const sourceWorkspace: RegisteredWorkspace = { ...workspace, repository: "owner/repo" };
const githubSourceControl = Schema.decodeSync(SourceControlType)("github");
const pullRequest = {
  number: 820,
  url: "https://github.com/owner/repo/pull/820",
  headBranch: "820-pull-request-output-actions",
  baseBranch: "main",
};
const sourceStep = (entry: string) =>
  WorkflowActionPlanStep.make({
    ...step(0, entry),
    target: {
      _tag: "CurrentPullRequest",
      workspace: sourceWorkspace.config.name,
      app: githubSourceControl,
      issueTracker: sourceWorkspace.config.issueTracker,
      repository: sourceWorkspace.repository ?? null,
      item: ref,
    },
  });

const openPullRequestStep = WorkflowActionPlanStep.make({
  ...step(0, "github.open-pull-request"),
  inputs: { pr_title: "Open the pull request", pr_body: "Closes #811" },
  target: {
    _tag: "NewPullRequest",
    workspace: sourceWorkspace.config.name,
    app: githubSourceControl,
    issueTracker: sourceWorkspace.config.issueTracker,
    repository: sourceWorkspace.repository ?? null,
    issue: item,
  },
});

const namedPullRequestStep = (
  position: number,
  entry: "github.post-review" | "github.draft-review",
  parameters: ReadonlyArray<{ readonly id: string; readonly value: string }> = [],
) =>
  WorkflowActionPlanStep.make({
    ...step(position, entry),
    parameters,
    inputs: {
      pull_request: "#826",
      review_body: "Review body",
      review_comments: [{ path: "src/review.ts", line: 12, body: "Change this." }],
    },
    target: {
      _tag: "NamedPullRequest",
      workspace: sourceWorkspace.config.name,
      app: githubSourceControl,
      issueTracker: sourceWorkspace.config.issueTracker,
      repository: sourceWorkspace.repository ?? null,
      number: 826,
      url: "https://github.com/owner/repo/pull/826",
      headBranch: "826-review-actions",
      baseBranch: "main",
      headSha: "abc123",
    },
  });

const slackStep = (
  position: number,
  entry: string,
  input: Readonly<Record<string, string>> = {},
  parameters: ReadonlyArray<{ readonly id: string; readonly value: string }> = [],
) =>
  WorkflowActionPlanStep.make({
    position,
    entry: decodeEntry(entry),
    parameters,
    inputs: input,
    target: decodeSlackTarget(
      entry === "slack.send-message"
        ? { _tag: "SlackChannel", channel: "C456" }
        : {
            _tag: "SlackMessage",
            team: "T123",
            channel: "C123",
            ts: "900.000",
            threadTs: "900.000",
          },
    ),
    writeKey: `write-${position}`,
    status: "pending",
    failures: 0,
    artifact: null,
  });

class ActionPlanProbe extends Context.Service<
  ActionPlanProbe,
  {
    readonly calls: Ref.Ref<ReadonlyArray<string>>;
    readonly barrier: Ref.Ref<number>;
    readonly parks: Ref.Ref<
      ReadonlyArray<{
        readonly reason: ParkReason;
        readonly operation: Parameters<CoordinationService["park"]>[2];
      }>
    >;
    readonly pushOrigins: Ref.Ref<ReadonlyArray<WorkflowActionArtifact["origin"]>>;
    readonly parkFailures: Ref.Ref<number>;
  }
>()("@cogwork/engine/workflow-action-plan.test/ActionPlanProbe") {
  static readonly layer = Layer.effect(
    ActionPlanProbe,
    Effect.all({
      calls: Ref.make<ReadonlyArray<string>>([]),
      barrier: Ref.make(0),
      parks: Ref.make<
        ReadonlyArray<{
          readonly reason: ParkReason;
          readonly operation: Parameters<CoordinationService["park"]>[2];
        }>
      >([]),
      pushOrigins: Ref.make<ReadonlyArray<WorkflowActionArtifact["origin"]>>([]),
      parkFailures: Ref.make(0),
    }),
  );
}

const viewAt = (barrierAtMillis: number) => ({
  ...fold({ claim: null, attempts: [], handbacks: [], parks: [], revision: null }, "cogwork"),
  barrierAtMillis,
});

const coordinationLayer = Layer.effect(
  Coordination,
  Effect.map(
    ActionPlanProbe,
    (probe) =>
      ({
        fold,
        read: () => Ref.get(probe.barrier).pipe(Effect.map(viewAt)),
        claim: () => Effect.die("unused"),
        release: () => Effect.die("unused"),
        recordAttempt: () => Effect.die("unused"),
        park: (_ref, reason, operation) =>
          Ref.modify(probe.parkFailures, (failures) =>
            failures > 0 ? [true, failures - 1] : [false, failures],
          ).pipe(
            Effect.flatMap((shouldFail) =>
              shouldFail
                ? Effect.die("park crashed")
                : Ref.update(probe.parks, (current) => [...current, { reason, operation }]),
            ),
            Effect.andThen(Ref.get(probe.barrier)),
            Effect.map(viewAt),
          ),
        handBack: () =>
          Ref.update(probe.barrier, (current) => current + 100).pipe(
            Effect.andThen(Ref.get(probe.barrier)),
            Effect.map(viewAt),
          ),
        observe: () => Effect.die("unused"),
        markProcessed: () => Effect.void,
      }) satisfies CoordinationService,
  ),
);

const trackerFailures = new Map<string, () => Effect.Effect<void, IssueTrackerError>>([
  [
    "retry",
    () => Effect.fail(new IssueTrackerError({ reason: "unavailable", retryable: true, message: "retry" })),
  ],
  [
    "fail",
    () =>
      Effect.fail(new IssueTrackerError({ reason: "unavailable", retryable: false, message: "permanent" })),
  ],
]);

const trackerResult = (body: string) => trackerFailures.get(body)?.() ?? Effect.void;

const trackerLayer = Layer.effect(
  IssueTracker,
  Effect.gen(function* () {
    const probe = yield* ActionPlanProbe;
    const base = yield* makeEmpty;
    return {
      ...base,
      commentIssue: (_workspace, _item, body, writeKey) =>
        Ref.update(probe.calls, (current) => [...current, `${body}:${writeKey}`]).pipe(
          Effect.andThen(trackerResult(body)),
        ),
      addLabels: (_workspace, _item, labels) =>
        Ref.update(probe.calls, (current) => [...current, `labels:${labels.join(",")}`]),
      closeIssue: () => Ref.update(probe.calls, (current) => [...current, "close"]),
    };
  }),
);

const slackLayer = Layer.effect(
  SlackWrite,
  Effect.map(ActionPlanProbe, (probe) => {
    const record = (value: string) => Ref.update(probe.calls, (current) => [...current, value]);
    const receipt = (channel: SlackChannelId, ts: string, threadTs: string | null) => ({
      team: slackTeam,
      channel,
      ts: decodeSlackTs(ts),
      threadTs: threadTs ? decodeSlackTs(threadTs) : null,
    });
    const draftOutcomes = new Map<string, () => Effect.Effect<void, SlackWriteError>>([
      [
        "unknown",
        () =>
          Effect.fail(
            new SlackWriteError({
              reason: "draft-outcome-unknown",
              retryable: false,
              message: "Slack draft outcome is unknown",
            }),
          ),
      ],
      ["crash", () => Effect.die("crashed after draft")],
    ]);
    return {
      sendMessage: (channel, message, writeKey) =>
        record(`send:${channel}:${message}:${writeKey}`).pipe(
          Effect.andThen(
            Ref.get(probe.calls).pipe(
              Effect.flatMap((calls) => {
                const firstRateLimit =
                  message === "rate-limit" &&
                  calls.filter((call) => call === `send:${channel}:${message}:${writeKey}`).length === 1;
                return firstRateLimit
                  ? Effect.fail(
                      new SlackWriteError({
                        reason: "rate-limited",
                        retryable: true,
                        message: "Slack rate limited the write",
                      }),
                    )
                  : Effect.succeed(receipt(channel, "901.000", null));
              }),
            ),
          ),
        ),
      replyInThread: (target, message, writeKey) =>
        record(`reply:${target.threadTs}:${message}:${writeKey}`).pipe(
          Effect.map(() => receipt(target.channel, "902.000", target.threadTs)),
        ),
      addReaction: (target, emoji) => record(`reaction:${target.ts}:${emoji}`),
      draftReply: (target, message) =>
        record(`draft:${target.threadTs}:${message}`).pipe(
          Effect.andThen(draftOutcomes.get(message)?.() ?? Effect.void),
        ),
    };
  }),
);

const adapterLayers = Layer.mergeAll(coordinationLayer, trackerLayer, slackLayer).pipe(
  Layer.provideMerge(ActionPlanProbe.layer),
);

const triggerObservationStoreLayer = Layer.effect(TriggerObservationStore, makeMemoryTriggerObservationStore);
const requirements = Layer.mergeAll(
  engineTestLayer(),
  workflowActionPlanStoreLayer,
  triggerObservationStoreLayer,
  workflowArtifactStoreLayer,
  adapterLayers,
);

describe("Workflow action plan", () => {
  it.effect("freezes the named pull request head and rejects review comments outside its diff", () =>
    Effect.gen(function* () {
      const reviewOperation = {
        id: operation,
        name: "Review",
        instructionPackage: null,
        instruction: "Review the named pull request.",
        permissionProfile: "read-only",
        requires: [],
        model: { harness: null, model: null, options: [] },
        forEach: null,
        questions: [],
        transitions: [
          {
            when: [],
            actions: [
              {
                entry: decodeEntry("github.post-review"),
                parameters: [{ id: "event", value: "comment" }],
              },
            ],
            handOff: null,
          },
        ],
        hints: [],
      } as const;
      const document = WorkflowDocument.make({
        name: "Review",
        workspaces: { _tag: "Every" },
        triggers: [],
        operations: [reviewOperation],
      });
      const sourceControl = {
        ...emptySourceControl,
        readPullRequest: () =>
          Effect.succeed({
            ...pullRequest,
            headSha: "abc123",
            title: "Review actions",
            description: "Adds review actions.",
            diff: "diff --git a/src/review.ts b/src/review.ts\n--- a/src/review.ts\n+++ b/src/review.ts\n@@ -10,2 +10,3 @@\n context\n-old\n+new\n tail",
            changedFiles: [
              {
                path: "src/review.ts",
                status: "modified",
                additions: 1,
                deletions: 1,
                changes: 2,
                patch: null,
              },
            ],
            comments: [],
          }),
      };
      const build = (line: number) =>
        buildWorkflowActionPlan({
          admission,
          document,
          operation: reviewOperation,
          catalog: { entries: [...githubSourceControlActionEntries], instructionPackages: [], harnesses: [] },
          workspaces: [sourceWorkspace],
          output: {
            summary: "Reviewed",
            answers: {},
            workspace: sourceWorkspace.config.name,
            inputs: {
              pull_request: "#826",
              review_body: "Review body",
              review_comments: [{ path: "src/review.ts", line, body: "Check this." }],
            },
          },
          attempt: decodeRun(`review-${line}`),
          createdAtMillis: 20,
          workflowRevision: 1,
          sourceControl,
        });

      const built = yield* Effect.result(build(12));
      const rejected = yield* Effect.result(build(99));

      assert.isTrue(Result.isSuccess(built));
      if (Result.isSuccess(built)) {
        assert.deepInclude(built.success.steps[0]?.target, {
          _tag: "NamedPullRequest",
          headSha: "abc123",
        });
      }
      assert.isTrue(Result.isFailure(rejected));
      if (Result.isFailure(rejected)) assert.include(rejected.failure.message, "src/review.ts:99");
    }),
  );

  it.effect("posts each review event once and creates one pending review", () => {
    const initial = plan([
      namedPullRequestStep(0, "github.post-review", [{ id: "event", value: "approve" }]),
      namedPullRequestStep(1, "github.post-review", [{ id: "event", value: "comment" }]),
      namedPullRequestStep(2, "github.post-review", [{ id: "event", value: "request-changes" }]),
      namedPullRequestStep(3, "github.draft-review"),
    ]);

    return Effect.gen(function* () {
      const probe = yield* ActionPlanProbe;
      yield* (yield* WorkflowActionPlanStore).create(initial);
      yield* executeWorkflowActionPlan(initial, admission);

      assert.deepStrictEqual(yield* Ref.get(probe.calls), [
        "review:approve:abc123",
        "review:comment:abc123",
        "review:request-changes:abc123",
        "draft:abc123",
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          requirements,
          Layer.effect(
            SourceControlProvider,
            Effect.map(ActionPlanProbe, (probe) => ({
              ...emptySourceControl,
              postReview: (_workspace, _pullRequest, event, input, origin) =>
                Ref.update(probe.calls, (calls) => [...calls, `review:${event}:${input.commitId}`]).pipe(
                  Effect.map(() =>
                    WorkflowActionArtifact.make({
                      kind: "PullRequestUpdated",
                      workspace: sourceWorkspace.config.name,
                      issue: decodeItem("#826"),
                      url: "https://github.com/owner/repo/pull/826",
                      origin,
                    }),
                  ),
                ),
              draftReview: (_workspace, _pullRequest, input, origin) =>
                Ref.update(probe.calls, (calls) => [...calls, `draft:${input.commitId}`]).pipe(
                  Effect.map(() =>
                    WorkflowActionArtifact.make({
                      kind: "PullRequestUpdated",
                      workspace: sourceWorkspace.config.name,
                      issue: decodeItem("#826"),
                      url: "https://github.com/owner/repo/pull/826",
                      origin,
                    }),
                  ),
                ),
            })),
          ).pipe(Layer.provideMerge(requirements)),
          Layer.succeed(
            WorkspaceRegistry,
            readOnlyRegistry({ ...emptyRegistry, workspaces: [sourceWorkspace] }),
          ),
        ),
      ),
      Effect.scoped,
    );
  });

  it.effect("freezes Slack channel and item targets before writing", () =>
    Effect.gen(function* () {
      const slackOperation = {
        id: operation,
        name: "Write",
        instructionPackage: null,
        instruction: "Respond in Slack.",
        permissionProfile: "read-only",
        requires: [],
        model: { harness: null, model: null, options: [] },
        forEach: null,
        questions: [],
        transitions: [
          {
            when: [],
            actions: [
              { entry: decodeEntry("slack.send-message"), parameters: [{ id: "channel", value: "C456" }] },
              { entry: decodeEntry("slack.reply-in-thread"), parameters: [] },
              { entry: decodeEntry("slack.add-reaction"), parameters: [{ id: "emoji", value: "eyes" }] },
              { entry: decodeEntry("slack.draft-reply-in-slack"), parameters: [] },
            ],
            handOff: null,
          },
        ],
        hints: [],
      } as const;
      const document = WorkflowDocument.make({
        name: "Slack writes",
        workspaces: { _tag: "Every" },
        triggers: [],
        operations: [slackOperation],
      });
      const catalog = {
        entries: slackActionEntries,
        instructionPackages: [],
        harnesses: [],
      };

      const built = yield* buildWorkflowActionPlan({
        admission: slackAdmission,
        document,
        operation: slackOperation,
        catalog,
        workspaces: [],
        output: { summary: "Respond", answers: {}, inputs: { message: "Hello", reply: "On it" } },
        attempt: decodeRun("slack-plan"),
        createdAtMillis: 20,
        workflowRevision: 1,
      });

      assert.deepStrictEqual(
        built.steps.map(({ target }) => target),
        [
          decodeSlackTarget({ _tag: "SlackChannel", channel: "C456" }),
          decodeSlackTarget({
            _tag: "SlackMessage",
            team: "T123",
            channel: "C123",
            ts: "900.000",
            threadTs: "900.000",
          }),
          decodeSlackTarget({
            _tag: "SlackMessage",
            team: "T123",
            channel: "C123",
            ts: "900.000",
            threadTs: "900.000",
          }),
          decodeSlackTarget({
            _tag: "SlackMessage",
            team: "T123",
            channel: "C123",
            ts: "900.000",
            threadTs: "900.000",
          }),
        ],
      );
    }),
  );

  it.effect("executes Slack writes in plan order", () =>
    Effect.gen(function* () {
      const probe = yield* ActionPlanProbe;
      const initial = WorkflowActionPlan.make({
        ...plan([
          slackStep(0, "slack.send-message", { message: "Hello" }),
          slackStep(1, "slack.reply-in-thread", { reply: "On it" }),
          slackStep(2, "slack.add-reaction", {}, [{ id: "emoji", value: "eyes" }]),
          slackStep(3, "slack.draft-reply-in-slack", { reply: "Looks good" }),
        ]),
        item: keyOf(slackRef),
      });
      const store = yield* WorkflowActionPlanStore;
      yield* store.create(initial);

      const result = yield* executeWorkflowActionPlan(initial, slackAdmission);

      assert.strictEqual(result._tag, "Complete");
      assert.deepStrictEqual(yield* Ref.get(probe.calls), [
        "send:C456:Hello:write-0",
        "reply:900.000:On it:write-1",
        "reaction:900.000:eyes",
        "draft:900.000:Looks good",
      ]);
      assert.isNull(yield* store.pending(initial.item, initial.workflow));
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("retries Slack 429 on the next execution with the same plan", () =>
    Effect.gen(function* () {
      const probe = yield* ActionPlanProbe;
      const initial = WorkflowActionPlan.make({
        ...plan([slackStep(0, "slack.send-message", { message: "rate-limit" })]),
        item: keyOf(slackRef),
      });
      const store = yield* WorkflowActionPlanStore;
      yield* store.create(initial);

      const first = yield* executeWorkflowActionPlan(initial, slackAdmission);
      const pending = yield* store.pending(initial.item, initial.workflow);
      const second = yield* executeWorkflowActionPlan(pending ?? initial, slackAdmission);

      assert.strictEqual(first._tag, "Retry");
      assert.strictEqual(second._tag, "Complete");
      assert.deepStrictEqual(yield* Ref.get(probe.calls), [
        "send:C456:rate-limit:write-0",
        "send:C456:rate-limit:write-0",
      ]);
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("records the posted timestamp and write origin before the next step retries", () =>
    Effect.gen(function* () {
      const initial = WorkflowActionPlan.make({
        ...plan([
          slackStep(0, "slack.send-message", { message: "Hello" }),
          slackStep(1, "slack.send-message", { message: "rate-limit" }),
        ]),
        item: keyOf(slackRef),
      });
      const store = yield* WorkflowActionPlanStore;
      yield* store.create(initial);

      const result = yield* executeWorkflowActionPlan(initial, slackAdmission);
      const saved = yield* store.pending(initial.item, initial.workflow);

      assert.strictEqual(result._tag, "Retry");
      const artifact = saved?.steps[0]?.artifact;
      assert.deepInclude(artifact, {
        team: slackTeam,
        channel: decodeSlackChannel("C456"),
        ts: decodeSlackTs("901.000"),
        threadTs: null,
      });
      assert.strictEqual(artifact?.origin.writeKey, "write-0");
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("parks an unknown draft outcome and never drafts it again", () =>
    Effect.gen(function* () {
      const probe = yield* ActionPlanProbe;
      const initial = WorkflowActionPlan.make({
        ...plan([slackStep(0, "slack.draft-reply-in-slack", { reply: "unknown" })]),
        item: keyOf(slackRef),
      });
      const store = yield* WorkflowActionPlanStore;
      yield* store.create(initial);

      const first = yield* executeWorkflowActionPlan(initial, slackAdmission);
      const saved = yield* store.pending(initial.item, initial.workflow);
      const second = yield* executeWorkflowActionPlan(saved ?? initial, slackAdmission);

      assert.strictEqual(first._tag, "Parked");
      assert.strictEqual(second._tag, "Parked");
      assert.deepStrictEqual(yield* Ref.get(probe.calls), ["draft:900.000:unknown"]);
      assert.deepInclude((yield* Ref.get(probe.parks))[0]?.reason, {
        _tag: "DraftOutcomeUnknown",
        step: "slack.draft-reply-in-slack",
      });
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("parks an in-flight draft after a crash without drafting again", () =>
    Effect.gen(function* () {
      const probe = yield* ActionPlanProbe;
      const initial = WorkflowActionPlan.make({
        ...plan([slackStep(0, "slack.draft-reply-in-slack", { reply: "crash" })]),
        item: keyOf(slackRef),
      });
      const store = yield* WorkflowActionPlanStore;
      yield* store.create(initial);

      const crashed = yield* Effect.exit(executeWorkflowActionPlan(initial, slackAdmission));
      const inFlight = yield* store.pending(initial.item, initial.workflow);
      const recovered = yield* Effect.exit(executeWorkflowActionPlan(inFlight ?? initial, slackAdmission));

      assert.strictEqual(crashed._tag, "Failure");
      assert.strictEqual(inFlight?.steps[0]?.status, "executing");
      assert.strictEqual(recovered._tag, "Success");
      if (recovered._tag === "Success") assert.strictEqual(recovered.value._tag, "Parked");
      assert.deepStrictEqual(yield* Ref.get(probe.calls), ["draft:900.000:crash"]);
      assert.strictEqual((yield* Ref.get(probe.parks))[0]?.reason._tag, "DraftOutcomeUnknown");
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("retries the park after an unknown draft outcome without drafting again", () =>
    Effect.gen(function* () {
      const probe = yield* ActionPlanProbe;
      const initial = WorkflowActionPlan.make({
        ...plan([slackStep(0, "slack.draft-reply-in-slack", { reply: "unknown" })]),
        item: keyOf(slackRef),
      });
      const store = yield* WorkflowActionPlanStore;
      yield* store.create(initial);
      yield* Ref.set(probe.parkFailures, 1);

      const crashed = yield* Effect.exit(executeWorkflowActionPlan(initial, slackAdmission));
      const inFlight = yield* store.pending(initial.item, initial.workflow);
      const recovered = yield* executeWorkflowActionPlan(inFlight ?? initial, slackAdmission);

      assert.strictEqual(crashed._tag, "Failure");
      assert.strictEqual(inFlight?.steps[0]?.status, "executing");
      assert.strictEqual(recovered._tag, "Parked");
      assert.deepStrictEqual(yield* Ref.get(probe.calls), ["draft:900.000:unknown"]);
      assert.strictEqual((yield* Ref.get(probe.parks))[0]?.reason._tag, "DraftOutcomeUnknown");
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("withdraws the pending approval for this item", () =>
    Effect.gen(function* () {
      const probe = yield* ActionPlanProbe;
      const store = yield* WorkflowActionPlanStore;
      const observationStore = yield* TriggerObservationStore;
      const waiting = WorkflowActionPlan.make({
        ...plan([step(0, "cogwork.wait-for-approval")]),
        attempt: decodeRun("waiting-attempt"),
      });
      const withdrawing = plan([step(0, "cogwork.withdraw-pending-approval")]);
      yield* store.create(waiting);
      yield* store.create(withdrawing);
      yield* observationStore.putAll([admission]);
      yield* executeWorkflowActionPlan(waiting, admission);

      const result = yield* executeWorkflowActionPlan(withdrawing, admission);

      assert.deepStrictEqual(result, { _tag: "Complete", handOff: null });
      assert.isEmpty(yield* store.list);
      assert.isEmpty(yield* observationStore.admissions);
      assert.strictEqual(yield* Ref.get(probe.barrier), 100);
    }).pipe(Effect.provide(requirements)),
  );

  it.effect("a completed stop clears the hand-off", () =>
    Effect.gen(function* () {
      const store = yield* WorkflowActionPlanStore;
      const initial = WorkflowActionPlan.make({
        ...plan([step(0, "cogwork.stop")]),
        handOff: decodeNode("next"),
      });
      yield* store.create(initial);

      const result = yield* executeWorkflowActionPlan(initial, admission);

      assert.deepStrictEqual(result, { _tag: "Complete", handOff: null });
    }).pipe(Effect.provide(requirements)),
  );

  it.effect("scopes an approval park to the waiting Operation", () =>
    Effect.gen(function* () {
      const probe = yield* ActionPlanProbe;
      const waiting = plan([step(0, "cogwork.wait-for-approval")]);

      const result = yield* executeWorkflowActionPlan(waiting, admission);
      const [park] = yield* Ref.get(probe.parks);

      assert.strictEqual(result._tag, "AwaitingApproval");
      assert.deepStrictEqual(park?.operation, {
        workflow: waiting.workflow,
        operation: waiting.operation,
      });
    }).pipe(Effect.provide(requirements)),
  );

  it.effect("parks the third retryable write failure with one stable write key", () =>
    Effect.gen(function* () {
      const probe = yield* ActionPlanProbe;
      const initial = plan([step(0, "github.comment-this-item", "retry")]);
      const store = yield* WorkflowActionPlanStore;
      yield* store.create(initial);

      const first = yield* executeWorkflowActionPlan(initial, admission);
      const afterFirst = yield* store.pending(initial.item, initial.workflow);
      const second = yield* executeWorkflowActionPlan(afterFirst ?? initial, admission);
      const afterSecond = yield* store.pending(initial.item, initial.workflow);
      const third = yield* executeWorkflowActionPlan(afterSecond ?? initial, admission);
      const saved = yield* store.pending(initial.item, initial.workflow);

      assert.strictEqual(first._tag, "Retry");
      assert.strictEqual(second._tag, "Retry");
      assert.strictEqual(third._tag, "Parked");
      assert.deepStrictEqual(yield* Ref.get(probe.calls), [
        "retry:write-0",
        "retry:write-0",
        "retry:write-0",
      ]);
      assert.deepInclude(saved?.steps[0], { status: "failed", failures: 3 });
      assert.deepInclude((yield* Ref.get(probe.parks))[0]?.reason, {
        _tag: "WriteFailed",
        step: "github.comment-this-item",
        error: "retry",
      });
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("a handback skips completed and failed writes, then runs the rest in order", () =>
    Effect.gen(function* () {
      const probe = yield* ActionPlanProbe;
      const initial = plan([
        step(0, "github.comment-this-item", "first"),
        step(1, "github.comment-this-item", "fail"),
        step(2, "github.close-this-issue"),
      ]);
      const store = yield* WorkflowActionPlanStore;
      yield* store.create(initial);

      const parked = yield* executeWorkflowActionPlan(initial, admission);
      const saved = yield* store.pending(initial.item, initial.workflow);
      const stillParked = yield* executeWorkflowActionPlan(saved ?? initial, admission);
      const callsBeforeHandback = yield* Ref.get(probe.calls);
      yield* (yield* Coordination).handBack(admission.event.key, { by: "Taylor" });
      const completed = yield* executeWorkflowActionPlan(saved ?? initial, admission);

      assert.strictEqual(parked._tag, "Parked");
      assert.strictEqual(stillParked._tag, "Parked");
      assert.deepStrictEqual(callsBeforeHandback, ["first:write-0", "fail:write-1"]);
      assert.strictEqual(completed._tag, "Complete");
      assert.deepStrictEqual(yield* Ref.get(probe.calls), ["first:write-0", "fail:write-1", "close"]);
      assert.isNull(yield* store.pending(initial.item, initial.workflow));
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("preserves retry budget until resumed writes park again", () =>
    Effect.gen(function* () {
      const probe = yield* ActionPlanProbe;
      const initial = plan([
        step(0, "github.comment-this-item", "fail"),
        step(1, "github.comment-this-item", "retry"),
      ]);
      const store = yield* WorkflowActionPlanStore;
      yield* store.create(initial);

      const first = yield* executeWorkflowActionPlan(initial, admission);
      const firstSaved = yield* store.pending(initial.item, initial.workflow);
      yield* (yield* Coordination).handBack(admission.event.key, { by: "Taylor" });
      const firstRetry = yield* executeWorkflowActionPlan(firstSaved ?? initial, admission);
      const firstRetrySaved = yield* store.pending(initial.item, initial.workflow);
      const secondRetry = yield* executeWorkflowActionPlan(firstRetrySaved ?? initial, admission);
      const secondRetrySaved = yield* store.pending(initial.item, initial.workflow);
      const parkedAgain = yield* executeWorkflowActionPlan(secondRetrySaved ?? initial, admission);
      const parkedAgainSaved = yield* store.pending(initial.item, initial.workflow);
      const staleResume = yield* executeWorkflowActionPlan(parkedAgainSaved ?? initial, admission);

      assert.strictEqual(first._tag, "Parked");
      assert.strictEqual(firstRetry._tag, "Retry");
      assert.strictEqual(secondRetry._tag, "Retry");
      assert.strictEqual(parkedAgain._tag, "Parked");
      assert.strictEqual(staleResume._tag, "Parked");
      assert.deepStrictEqual(yield* Ref.get(probe.calls), [
        "fail:write-0",
        "retry:write-1",
        "retry:write-1",
        "retry:write-1",
      ]);
      assert.isNotNull(yield* store.pending(initial.item, initial.workflow));
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("parks before every write when the plan has no recognized Workspace", () =>
    Effect.gen(function* () {
      const probe = yield* ActionPlanProbe;
      const missingWorkspace = WorkflowActionPlanStep.make({
        ...step(1, "github.close-this-issue"),
        target: { _tag: "NoWorkspace" },
      });
      const initial = plan([step(0, "github.comment-this-item", "first"), missingWorkspace]);
      yield* (yield* WorkflowActionPlanStore).create(initial);

      const result = yield* executeWorkflowActionPlan(initial, admission);
      const parked = (yield* Ref.get(probe.parks))[0]?.reason;

      assert.strictEqual(result._tag, "Parked");
      assert.isEmpty(yield* Ref.get(probe.calls));
      assert.strictEqual(parked?._tag, "NoWorkspaceRecognized");
      if (parked?._tag !== "NoWorkspaceRecognized") return;
      const parkedPlan = yield* Schema.decodeEffect(
        Schema.fromJsonString(
          Schema.Struct({
            summary: Schema.String,
            steps: Schema.Array(Schema.Struct({ position: Schema.Finite, entry: WorkflowCatalogKey })),
          }),
        ),
      )(parked.plan);
      assert.deepStrictEqual(
        parkedPlan.steps.map(({ entry }) => entry),
        ["github.comment-this-item", "github.close-this-issue"],
      );
      assert.notInclude(parked.plan, "first");
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("refuses an action whose frozen app does not match its entry", () =>
    Effect.gen(function* () {
      const probe = yield* ActionPlanProbe;
      const mismatched = WorkflowActionPlanStep.make({
        ...step(0, "github.close-this-issue"),
        target: {
          _tag: "CurrentIssue",
          workspace: linearConfig.name,
          app: linearConfig.issueTracker.type,
          issueTracker: linearConfig.issueTracker,
          repository: null,
          issue: item,
        },
      });
      const initial = plan([mismatched]);
      yield* (yield* WorkflowActionPlanStore).create(initial);

      const result = yield* executeWorkflowActionPlan(initial, admission);

      assert.strictEqual(result._tag, "Parked");
      assert.isEmpty(yield* Ref.get(probe.calls));
      assert.strictEqual((yield* Ref.get(probe.parks))[0]?.reason._tag, "WriteFailed");
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("parks add-label with no labels before writing", () =>
    Effect.gen(function* () {
      const probe = yield* ActionPlanProbe;
      const initial = plan([step(0, "github.add-label")]);
      yield* (yield* WorkflowActionPlanStore).create(initial);

      const result = yield* executeWorkflowActionPlan(initial, admission);

      assert.strictEqual(result._tag, "Parked");
      assert.isEmpty(yield* Ref.get(probe.calls));
      assert.deepInclude((yield* Ref.get(probe.parks))[0]?.reason, {
        _tag: "WriteFailed",
        step: "github.add-label",
        error: "Action github.add-label has an invalid target",
      });
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("completes a pull request push without a write when there are no new commits", () => {
    const worktreeLayer = Layer.mock(WorktreeManager, {
      pushBranchIfAhead: () => Effect.succeed(false),
    });
    const registryLayer = Layer.succeed(
      WorkspaceRegistry,
      readOnlyRegistry({ ...emptyRegistry, workspaces: [sourceWorkspace] }),
    );
    const initial = plan([sourceStep("github.push-to-this-pull-request")]);
    return Effect.gen(function* () {
      const probe = yield* ActionPlanProbe;
      yield* (yield* WorkflowActionPlanStore).create(initial);
      const result = yield* executeWorkflowActionPlan(initial, admission);

      assert.deepStrictEqual(result, { _tag: "Complete", handOff: null });
      assert.isEmpty(yield* Ref.get(probe.pushOrigins));
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.effect(
            SourceControlProvider,
            Effect.map(ActionPlanProbe, (probe) => ({
              ...emptySourceControl,
              resolvePullRequest: () => Effect.succeed(pullRequest),
              recordPullRequestPush: (_workspace, resolved, origin) =>
                Ref.update(probe.pushOrigins, (current) => [...current, origin]).pipe(
                  Effect.map(() =>
                    WorkflowActionArtifact.make({
                      kind: "PullRequestUpdated",
                      workspace: sourceWorkspace.config.name,
                      issue: decodeItem(`#${resolved.number}`),
                      url: resolved.url,
                      origin,
                    }),
                  ),
                ),
            })),
          ).pipe(Layer.provideMerge(requirements)),
          worktreeLayer,
          registryLayer,
        ),
      ),
      Effect.scoped,
    );
  });

  it.effect("records the Run origin when it pushes new pull request commits", () => {
    const worktreeLayer = Layer.mock(WorktreeManager, {
      pushBranchIfAhead: () => Effect.succeed(true),
    });
    const registryLayer = Layer.succeed(
      WorkspaceRegistry,
      readOnlyRegistry({ ...emptyRegistry, workspaces: [sourceWorkspace] }),
    );
    const initial = plan([sourceStep("github.push-to-this-pull-request")]);

    return Effect.gen(function* () {
      const probe = yield* ActionPlanProbe;
      yield* (yield* WorkflowActionPlanStore).create(initial);
      yield* executeWorkflowActionPlan(initial, admission);
      assert.deepInclude((yield* Ref.get(probe.pushOrigins))[0], {
        attempt: initial.attempt,
        writeKey: "write-0",
      });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.effect(
            SourceControlProvider,
            Effect.map(ActionPlanProbe, (probe) => ({
              ...emptySourceControl,
              resolvePullRequest: () => Effect.succeed(pullRequest),
              recordPullRequestPush: (_workspace, resolved, origin) =>
                Ref.update(probe.pushOrigins, (current) => [...current, origin]).pipe(
                  Effect.map(() =>
                    WorkflowActionArtifact.make({
                      kind: "PullRequestUpdated",
                      workspace: sourceWorkspace.config.name,
                      issue: decodeItem(`#${resolved.number}`),
                      url: resolved.url,
                      origin,
                    }),
                  ),
                ),
            })),
          ).pipe(Layer.provideMerge(requirements)),
          worktreeLayer,
          registryLayer,
        ),
      ),
      Effect.scoped,
    );
  });

  it.effect("freezes a new pull request only when the Run branch is ahead", () => {
    const openOperation = {
      id: operation,
      name: "Implement",
      instructionPackage: null,
      instruction: "Implement the Issue.",
      permissionProfile: "full",
      requires: [],
      model: { harness: null, model: null, options: [] },
      forEach: null,
      questions: [],
      transitions: [
        {
          when: [],
          actions: [{ entry: decodeEntry("github.open-pull-request"), parameters: [] }],
          handOff: null,
        },
      ],
      hints: [],
    } as const;
    const document = WorkflowDocument.make({
      name: "Implement",
      workspaces: { _tag: "Every" },
      triggers: [],
      operations: [openOperation],
    });
    const reason = "head 811-behind is not ahead of origin/main";
    const offline = "could not fetch origin";
    const readiness: Record<string, Effect.Effect<PullRequestReadiness, GitError>> = {
      "811-ahead": Effect.succeed(
        PullRequestReadiness.Ready({ headBranch: "811-ahead", baseBranch: "main" }),
      ),
      "811-behind": Effect.succeed(PullRequestReadiness.Declined({ reason })),
      "811-offline": Effect.fail(
        new GitError({ command: "git fetch origin", message: offline, retryable: true }),
      ),
    };
    const worktreeLayer = Layer.mock(WorktreeManager, {
      pullRequestReadiness: (_workspace, _item, headBranch = "") =>
        readiness[headBranch] ?? Effect.die(`unexpected head ${headBranch}`),
    });
    return Effect.gen(function* () {
      const worktrees = yield* WorktreeManager;
      const build = (runBranch: string) =>
        buildWorkflowActionPlan({
          admission,
          document,
          operation: openOperation,
          catalog: { entries: [...githubSourceControlActionEntries], instructionPackages: [], harnesses: [] },
          workspaces: [sourceWorkspace],
          output: {
            summary: "Implemented",
            answers: {},
            workspace: sourceWorkspace.config.name,
            inputs: { pr_title: "Open the pull request", pr_body: "Closes #811" },
          },
          attempt: decodeRun(`open-${runBranch}`),
          createdAtMillis: 20,
          workflowRevision: 1,
          worktrees,
          runBranch,
        });

      const ready = yield* build("811-ahead");
      const declined = yield* Effect.flip(build("811-behind"));
      const unavailable = yield* Effect.flip(build("811-offline"));

      assert.deepStrictEqual(ready.steps[0]?.target, openPullRequestStep.target);
      assert.deepInclude(declined, { reason: "declined", message: reason });
      assert.deepInclude(unavailable, { reason: "unavailable", message: offline });
    }).pipe(Effect.provide(worktreeLayer));
  });

  it.effect("opens the pull request from the Run branch without a second readiness check", () => {
    const sourceControlLayer = Layer.effect(
      SourceControlProvider,
      Effect.map(ActionPlanProbe, (probe) => ({
        ...emptySourceControl,
        openWorkflowPullRequest: (_workspace, input) =>
          Ref.update(probe.calls, (calls) => [
            ...calls,
            `open:${input.headBranch}->${input.baseBranch}`,
          ]).pipe(
            Effect.map(() =>
              WorkflowActionArtifact.make({
                kind: "PullRequestOpened",
                workspace: sourceWorkspace.config.name,
                issue: decodeItem("#830"),
                url: "https://github.com/owner/repo/pull/830",
                origin: input.origin,
              }),
            ),
          ),
      })),
    );
    const worktreeLayer = Layer.unwrap(
      Effect.map(ActionPlanProbe, (probe) =>
        Layer.mock(WorktreeManager, {
          pullRequestReadiness: (_workspace, _item, headBranch = "") =>
            Ref.update(probe.calls, (calls) => [...calls, "readiness"]).pipe(
              Effect.map(() => PullRequestReadiness.Ready({ headBranch, baseBranch: "main" })),
            ),
          pushBranch: (_workspace, headBranch) =>
            Ref.update(probe.calls, (calls) => [...calls, `push:${headBranch}`]),
        }),
      ),
    );
    const registryLayer = Layer.succeed(
      WorkspaceRegistry,
      readOnlyRegistry({ ...emptyRegistry, workspaces: [sourceWorkspace] }),
    );
    const initial = plan([openPullRequestStep]);

    return Effect.gen(function* () {
      const ledger = yield* RunLedger;
      yield* ledger.insertRun({
        id: initial.attempt,
        workspace: sourceWorkspace.config.name,
        workItem: item,
        operation: "implement",
        harness: decodeHarness("scripted"),
        branch: decodeBranch("811-open-the-pull-request"),
        session: null,
        usage: null,
        status: "running",
        startedAtMillis: 1,
        endedAtMillis: null,
      });
      yield* (yield* WorkflowActionPlanStore).create(initial);
      const result = yield* executeWorkflowActionPlan(initial, admission);
      assert.deepStrictEqual(result, { _tag: "Complete", handOff: null });
      assert.deepStrictEqual(yield* Ref.get((yield* ActionPlanProbe).calls), [
        "push:811-open-the-pull-request",
        "open:811-open-the-pull-request->main",
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mergeAll(sourceControlLayer, worktreeLayer).pipe(Layer.provideMerge(requirements)),
          registryLayer,
        ),
      ),
      Effect.scoped,
    );
  });
});
