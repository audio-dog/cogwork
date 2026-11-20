import {
  BranchName,
  ControlStoreFailure,
  HarnessName,
  keyOf,
  type ParkReason,
  RunId,
  SlackChannelId,
  SlackMessageTs,
  SlackTeamId,
  SourceControlType,
  WorkflowActionArtifact,
  type WorkflowActionOrigin,
  WorkflowActionPlan,
  WorkflowActionPlanStep,
  WorkflowActionTarget,
  WorkflowCatalogKey,
  WorkflowId,
  WorkflowNodeId,
  WorkItemId,
  WorkspaceConfig,
} from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { Coordination, type CoordinationService, fold } from "./coordination";
import { IssueTracker, IssueTrackerError, makeEmpty } from "./issue-tracker";
import type { RegisteredWorkspace } from "./projector";
import { emptyRegistry } from "./projector";
import { readOnlyRegistry, WorkspaceRegistry } from "./registry-service";
import { SlackWrite, SlackWriteError } from "./slack-write";
import {
  emptyService as emptySourceControl,
  type ResolvedPullRequest,
  SourceControlProvider,
} from "./source-control";
import { engineTestLayer } from "./testing/engine-test-layer";
import type { TriggerAdmission } from "./trigger-observation-admission";
import { makeMemoryTriggerObservationStore, TriggerObservationStore } from "./trigger-observation-store";
import { memoryLayer as workflowActionPlanStoreLayer } from "./workflow-action-plan-store";
import { WorkflowArtifactStore, memoryLayer as workflowArtifactStoreLayer } from "./workflow-artifact-store";
import { WorktreeManager } from "./worktree";

const decodeWorkflow = Schema.decodeSync(WorkflowId);
export const decodeNode = Schema.decodeSync(WorkflowNodeId);
export const decodeRun = Schema.decodeSync(RunId);
export const decodeItem = Schema.decodeSync(WorkItemId);
export const decodeSlackTarget = Schema.decodeSync(WorkflowActionTarget);
export const decodeSlackChannel = Schema.decodeSync(SlackChannelId);
export const decodeSlackTs = Schema.decodeSync(SlackMessageTs);
export const slackTeam = Schema.decodeSync(SlackTeamId)("T123");
export const decodeEntry = Schema.decodeSync(WorkflowCatalogKey);
export const decodeHarness = Schema.decodeSync(HarnessName);
export const decodeBranch = Schema.decodeSync(BranchName);
export const workflow = decodeWorkflow("issue-writes");
export const operation = decodeNode("write");
const trigger = decodeNode("issue-changed");
export const workspace: RegisteredWorkspace = {
  source: "control-store:workspace",
  contributions: [],
  config: Schema.decodeSync(WorkspaceConfig)({
    id: "repo",
    displayName: "repo",
    checkoutPath: "/repo",
    issueTracker: { type: "github" },
  }),
};
export const item = decodeItem("#811");
export const linearConfig = Schema.decodeSync(WorkspaceConfig)({
  id: "linear",
  displayName: "linear",
  checkoutPath: "/linear",
  issueTracker: { type: "linear", teams: ["CGW"] },
});
export const ref = { _tag: "Issue", workspace: workspace.config.id, id: item } as const;
export const admission: TriggerAdmission = {
  event: {
    key: ref,
    revision: "1",
    cause: { _tag: "Unknown" },
    atMillis: 1,
    entry: decodeEntry("github.issue-changed"),
    workspace: workspace.config.id,
  },
  subscription: {
    workflow,
    trigger,
    operation,
    entry: decodeEntry("github.issue-changed"),
    parameters: [],
    filters: [],
    workspaces: [workspace.config.id],
    catchUp: { since: 0 },
  },
  lineage: {
    root: Schema.decodeSync(Schema.String.pipe(Schema.brand("LineageId")))(keyOf(ref)),
    parent: null,
    hop: 0,
  },
};

export const slackRef = { _tag: "SlackMessage", team: "T123", channel: "C123", ts: "900.000" } as const;
export const slackAdmission: TriggerAdmission = {
  ...admission,
  event: {
    ...admission.event,
    key: slackRef,
    entry: decodeEntry("slack.i-am-mentioned"),
    workspace: null,
  },
};

export const plan = (steps: ReadonlyArray<WorkflowActionPlanStep>) =>
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

export const step = (position: number, entry: string, comment = "") =>
  WorkflowActionPlanStep.make({
    position,
    entry: decodeEntry(entry),
    parameters: [],
    inputs: comment === "" ? {} : { comment },
    target: {
      _tag: "CurrentIssue",
      workspace: workspace.config.id,
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

export const sourceWorkspace: RegisteredWorkspace = { ...workspace, repository: "owner/repo" };
const githubSourceControl = Schema.decodeSync(SourceControlType)("github");
export const pullRequest = {
  number: 820,
  url: "https://github.com/owner/repo/pull/820",
  headBranch: "820-pull-request-output-actions",
  baseBranch: "main",
};
export const sourceStep = (entry: string) =>
  WorkflowActionPlanStep.make({
    ...step(0, entry),
    target: {
      _tag: "CurrentPullRequest",
      workspace: sourceWorkspace.config.id,
      app: githubSourceControl,
      issueTracker: sourceWorkspace.config.issueTracker,
      repository: sourceWorkspace.repository ?? null,
      item: ref,
    },
  });

export const openPullRequestStep = WorkflowActionPlanStep.make({
  ...step(0, "github.open-pull-request"),
  inputs: { pr_title: "Open the pull request", pr_body: "Closes #811" },
  target: {
    _tag: "NewPullRequest",
    workspace: sourceWorkspace.config.id,
    app: githubSourceControl,
    issueTracker: sourceWorkspace.config.issueTracker,
    repository: sourceWorkspace.repository ?? null,
    issue: item,
  },
});

export const namedPullRequestStep = (
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
      workspace: sourceWorkspace.config.id,
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

export const slackStep = (
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

export class ActionPlanProbe extends Context.Service<
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
>()("@cogwork/engine/workflow-action-plan-fixtures/ActionPlanProbe") {
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
const requirementsWith = <E>(artifactStore: Layer.Layer<WorkflowArtifactStore, E>) =>
  Layer.mergeAll(
    engineTestLayer(),
    workflowActionPlanStoreLayer,
    triggerObservationStoreLayer,
    artifactStore,
    adapterLayers,
  );
export const requirements = requirementsWith(workflowArtifactStoreLayer);

export const pullRequestUpdate = (
  resolved: Pick<ResolvedPullRequest, "number" | "url">,
  origin: WorkflowActionOrigin,
) =>
  WorkflowActionArtifact.make({
    kind: "PullRequestUpdated",
    workspace: sourceWorkspace.config.id,
    issue: decodeItem(`#${resolved.number}`),
    url: resolved.url,
    origin,
  });

interface PullRequestWriteOptions<E> {
  readonly artifacts?: Layer.Layer<WorkflowArtifactStore, E>;
  readonly branchAhead?: boolean;
}

export const pullRequestWrites = <E = never>({
  artifacts,
  branchAhead = true,
}: PullRequestWriteOptions<E> = {}) =>
  Layer.mergeAll(
    Layer.effect(
      SourceControlProvider,
      Effect.map(ActionPlanProbe, (probe) => ({
        ...emptySourceControl,
        resolvePullRequest: () => Effect.succeed(pullRequest),
        recordPullRequestPush: (_workspace, resolved, origin) =>
          Ref.update(probe.pushOrigins, (current) => [...current, origin]).pipe(
            Effect.map(() => pullRequestUpdate(resolved, origin)),
          ),
        commentPullRequest: (_workspace, resolved, _body, origin) =>
          Effect.succeed(pullRequestUpdate(resolved, origin)),
      })),
    ),
    Layer.mock(WorktreeManager, { pushBranchIfAhead: () => Effect.succeed(branchAhead) }),
    Layer.succeed(WorkspaceRegistry, readOnlyRegistry({ ...emptyRegistry, workspaces: [sourceWorkspace] })),
  ).pipe(Layer.provideMerge(requirementsWith(artifacts ?? workflowArtifactStoreLayer)));

export const failingArtifacts = Layer.mock(WorkflowArtifactStore, {
  record: () =>
    Effect.fail(
      ControlStoreFailure.make({
        operation: "record Workflow artifact",
        message: "database is locked",
        retryable: true,
      }),
    ),
});
