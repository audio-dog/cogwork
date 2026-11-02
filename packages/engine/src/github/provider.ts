import {
  WorkflowActionArtifact,
  type WorkflowActionOrigin,
  type WorkflowCatalogEntry,
  WorkflowCatalogKey,
  type WorkflowOptionList,
  type WorkItem,
  WorkItemId,
  WorkItemRef,
} from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { checkState } from "../ci";
import { IssueTrackerError } from "../issue-tracker";
import type { RegisteredWorkspace, RegistryState } from "../projector";
import { WorkspaceRegistry } from "../registry";
import {
  type PrReview,
  type PrSignals,
  type ResolvedPullRequest,
  SourceControlProvider,
  type SourceControlProviderService,
} from "../source-control";
import type { WorkflowCatalogContribution } from "../workflow-catalog";
import { branchBelongsToTicketSlug, branchName, ticketSlug } from "../worktree";
import {
  GitHubClient,
  type GitHubClientService,
  type GitHubRepoRef,
  type RawPull,
  type ReviewDecision,
  reviewDecisionOf,
} from "./client";
import { wireCodec } from "./markers";
import { makeGitHubPullRequestTriggerSource } from "./pull-request-trigger-source";
import { baseDivergenceOf, type GitHubTargetConfig, sourceControlTargetFor } from "./source-control-target";

export { baseDivergenceOf } from "./source-control-target";

const catalogKey = Schema.decodeSync(WorkflowCatalogKey);

const reviewerParameter = {
  id: "reviewer",
  required: true,
  source: "live",
  values: [],
} satisfies WorkflowCatalogEntry["parameters"][number];

const sourceControlAction = (
  id: string,
  name: string,
  permissionProfile: WorkflowCatalogEntry["permissionProfile"],
  agentInputs: ReadonlyArray<string>,
  parameters: WorkflowCatalogEntry["parameters"] = [],
  actsOn: ReadonlyArray<string> = ["issue", "pull-request"],
) =>
  ({
    key: catalogKey(`github.${id}`),
    name,
    kind: "action",
    system: "github",
    connection: "github",
    requires: [],
    parameters,
    itemKind: null,
    actsOn,
    requiresWorkspace: true,
    permissionProfile,
    agentInputs,
    emits: [],
  }) satisfies WorkflowCatalogEntry;

export const githubSourceControlActionEntries = [
  sourceControlAction(
    "open-pull-request",
    "Open a pull request",
    "full",
    ["pr_title", "pr_body"],
    [],
    ["issue"],
  ),
  sourceControlAction("push-to-this-pull-request", "Push to this pull request", "full", []),
  sourceControlAction("comment-on-this-pull-request", "Comment on this pull request", "read-only", [
    "comment",
  ]),
  sourceControlAction("request-review", "Request a review", "read-only", [], [reviewerParameter]),
] as const;

interface GitHubTarget extends GitHubTargetConfig {
  readonly actorLogin: string;
}

const missingSourceControlTarget = () =>
  new IssueTrackerError({
    reason: "unavailable",
    retryable: false,
    message: "GitHub source control target is not configured",
  });

const sourceControlTarget = (workspace: RegisteredWorkspace) => {
  const target = sourceControlTargetFor(workspace);
  return target ? Effect.succeed(target) : Effect.fail(missingSourceControlTarget());
};

export const branchBelongsToSlug = branchBelongsToTicketSlug;

export const prReview = (pull: RawPull, decision: ReviewDecision): PrReview => {
  if (pull.draft) return "pending";
  if (decision === "changes-requested") return "changes-requested";
  if (decision === "approved") return "ready";
  return "pending";
};

const pullNumberFromUrl = (url: string) => {
  const value = url.match(/\/pull\/(\d+)(?:$|[?#])/i)?.[1];
  return value === undefined ? null : Number.parseInt(value, 10);
};

export const readyToMergeArtifact = (
  pull: RawPull,
  actorLogin: string,
  artifacts: ReadonlyArray<WorkflowActionArtifact>,
) =>
  pull.authorLogin === actorLogin
    ? (artifacts.find((artifact) => pullNumberFromUrl(artifact.url) === pull.number) ?? null)
    : null;

export const isReadyToMerge = (signals: PrSignals) =>
  !signals.draft &&
  signals.checks === "passing" &&
  signals.baseDivergence !== "conflict" &&
  signals.review === "ready";

const numericIssue = /^#(\d+)$/;

const writeAccess = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

const make = (
  client: GitHubClientService,
  registry: Effect.Effect<RegistryState>,
): SourceControlProviderService => {
  const authenticatedTarget = Effect.fn("github.authenticatedSourceControlTarget")(function* (
    target: GitHubTargetConfig,
  ) {
    const actorLogin = yield* client.authenticatedLogin(target);
    return { ...target, actorLogin } satisfies GitHubTarget;
  });

  const observePr = Effect.fn("github.observePr")(function* (target: GitHubTarget, pull: RawPull) {
    const [checks, reviews, mergeableState] = yield* Effect.all([
      client.listCheckRuns(target, pull.headSha),
      client.listReviews(target, pull.number),
      client.pullMergeableState(target, pull.number),
    ]);
    const decision = reviewDecisionOf(
      reviews
        .filter((review) => writeAccess.has(review.authorAssociation))
        .map((review) => ({ login: review.authorLogin, state: review.state })),
    );
    return {
      number: pull.number,
      url: pull.url,
      review: prReview(pull, decision),
      checks: checkState(checks),
      baseDivergence: baseDivergenceOf(mergeableState),
      waitingSinceMillis: pull.updatedAtMillis,
      draft: pull.draft,
    } satisfies PrSignals;
  });

  const daemonPull = (target: GitHubTarget, pull: RawPull) =>
    pull.authorLogin === target.actorLogin || writeAccess.has(pull.authorAssociation);

  // The final key is the PR number: the higher number is the newer PR, since GitHub numbers them in
  // creation order.
  const closesItem = (item: WorkItem, pull: RawPull) => {
    const match = numericIssue.exec(item.id);
    return match ? pull.closingIssueNumbers.includes(Number(match[1])) : false;
  };

  const sameRepositoryHead = (target: GitHubRepoRef, pull: RawPull) =>
    pull.headRepository?.toLowerCase() === `${target.owner}/${target.name}`.toLowerCase();

  const rank = (target: GitHubTarget, item: WorkItem, branch: string, pull: RawPull) =>
    [
      sameRepositoryHead(target, pull) ? 1 : 0,
      pull.draft ? 0 : 1,
      closesItem(item, pull) ? 1 : 0,
      pull.headRef === branch ? 1 : 0,
      pull.authorLogin === target.actorLogin ? 1 : 0,
      pull.number,
    ] as const;

  const outranks = (target: GitHubTarget, item: WorkItem, branch: string, a: RawPull, b: RawPull) => {
    const [aSameRepository, aNonDraft, aClosing, aExact, aBot, aNumber] = rank(target, item, branch, a);
    const [bSameRepository, bNonDraft, bClosing, bExact, bBot, bNumber] = rank(target, item, branch, b);
    if (aSameRepository !== bSameRepository) return aSameRepository > bSameRepository;
    if (aNonDraft !== bNonDraft) return aNonDraft > bNonDraft;
    if (aClosing !== bClosing) return aClosing > bClosing;
    if (aExact !== bExact) return aExact > bExact;
    if (aBot !== bBot) return aBot > bBot;
    return aNumber > bNumber;
  };

  const linkedPull = (target: GitHubTarget, item: WorkItem, trusted: ReadonlyArray<RawPull>) => {
    const slug = ticketSlug(item.id);
    const branch = branchName(item);
    const better = (best: RawPull | null, pull: RawPull) => {
      if (!closesItem(item, pull) && !branchBelongsToSlug(pull.headRef, slug)) return best;
      if (best === null) return pull;
      return outranks(target, item, branch, pull, best) ? pull : best;
    };
    return trusted.reduce<RawPull | null>(better, null);
  };

  // The pulls the daemon trusts to act on: those it authored or that a write-access account opened.
  const trustedPulls = Effect.fn("github.trustedPulls")(function* (target: GitHubTarget) {
    const pulls = yield* client.listPulls(target);
    return pulls.filter((pull) => daemonPull(target, pull));
  });

  const writeMarker = (writeKey: string) =>
    wireCodec.encode({ name: "write", pairs: `key=${encodeURIComponent(writeKey)}` });

  const carriesWriteKey = (body: string, writeKey: string) =>
    wireCodec
      .scan(body)
      .some(({ name, pairs }) => name === "write" && pairs === `key=${encodeURIComponent(writeKey)}`);

  const workflowMarkedBody = (body: string, writeKey: string) =>
    [body.trim(), writeMarker(writeKey)].filter((part) => part.length > 0).join("\n\n");

  const workflowArtifact = (
    workspace: RegisteredWorkspace,
    pullRequest: ResolvedPullRequest,
    origin: WorkflowActionOrigin,
  ) =>
    WorkflowActionArtifact.make({
      workspace: workspace.config.name,
      issue: WorkItemId.make(`#${pullRequest.number}`),
      url: pullRequest.url,
      origin,
    });

  const resolvedPull = (workspace: RegisteredWorkspace, pull: RawPull): ResolvedPullRequest => ({
    number: pull.number,
    url: pull.url,
    headBranch: pull.headRef,
    baseBranch: pull.baseRef ?? workspace.config.worktrees?.baseBranch ?? "main",
  });

  const pullForItem = (target: GitHubTarget, item: WorkItemRef, pulls: ReadonlyArray<RawPull>) =>
    WorkItemRef.match(item, {
      Issue: ({ id }) =>
        linkedPull(
          target,
          { id, title: "" },
          pulls.filter(({ authorLogin }) => authorLogin === target.actorLogin),
        ),
      PullRequest: ({ number }) => pulls.find((pull) => pull.number === number) ?? null,
      GranolaNote: () => null,
      SlackMessage: () => null,
      SlackConversation: () => null,
      ScheduleInstant: () => null,
      FanOutChild: () => null,
    });

  const resolvePullRequest = Effect.fn("github.resolvePullRequest")(function* (
    workspace: RegisteredWorkspace,
    item: WorkItemRef,
  ) {
    const configuredTarget = yield* sourceControlTarget(workspace);
    const target = yield* authenticatedTarget(configuredTarget);
    const pulls = (yield* trustedPulls(target)).filter((pull) => sameRepositoryHead(target, pull));
    const pull = pullForItem(target, item, pulls);
    return pull ? resolvedPull(workspace, pull) : null;
  });

  const commentsCarry = (target: GitHubTarget, pullNumber: number, writeKey: string) =>
    client
      .listAllComments(target, pullNumber)
      .pipe(
        Effect.map((comments) =>
          comments.some(
            ({ authorLogin, body }) => authorLogin === target.actorLogin && carriesWriteKey(body, writeKey),
          ),
        ),
      );

  const markPullRequest = Effect.fn("github.markWorkflowPullRequest")(function* (
    target: GitHubTarget,
    pullNumber: number,
    writeKey: string,
  ) {
    if (yield* commentsCarry(target, pullNumber, writeKey)) return;
    yield* client.createComment(target, pullNumber, writeMarker(writeKey));
  });

  const contribution: WorkflowCatalogContribution = {
    entries: githubSourceControlActionEntries,
    templates: [],
    listOptions: (entry, parameter, workspaces) => {
      const listsReviewers = entry === catalogKey("github.request-review") && parameter === "reviewer";
      if (!listsReviewers) return Effect.succeed([]);
      return registry.pipe(
        Effect.flatMap((state) =>
          Effect.forEach(workspaces, (workspaceId) => {
            const workspace = state.workspaces.find(({ config }) => config.name === workspaceId);
            const target = workspace ? sourceControlTargetFor(workspace) : null;
            if (!target) return Effect.succeed([]);
            return client.listCollaborators(target).pipe(
              Effect.map((reviewers) =>
                reviewers.map((reviewer) => ({
                  value: reviewer,
                  name: reviewer,
                  listedIn: [workspaceId],
                })),
              ),
              Effect.catchTag("IssueTrackerError", () => Effect.succeed([])),
            );
          }),
        ),
        Effect.map((listed) => {
          const byReviewer = listed.flat().reduce((options, option) => {
            const current = options.get(option.value);
            return options.set(option.value, {
              ...option,
              listedIn: [...new Set([...(current?.listedIn ?? []), ...option.listedIn])],
            });
          }, new Map<string, WorkflowOptionList[number]>());
          return [...byReviewer.values()];
        }),
      );
    },
  };

  const readyToMerge = Effect.fn("github.readyToMerge")(function* (
    workspace: RegisteredWorkspace,
    artifacts: ReadonlyArray<WorkflowActionArtifact>,
  ) {
    const configuredTarget = sourceControlTargetFor(workspace);
    if (!configuredTarget) return [];
    const target = yield* authenticatedTarget(configuredTarget);
    const pulls = (yield* client.listPulls(target)).filter(
      (pull) => readyToMergeArtifact(pull, target.actorLogin, artifacts) !== null,
    );
    const observed = yield* Effect.forEach(pulls, (pull) =>
      observePr(target, pull).pipe(Effect.map((signals) => ({ pull, signals }))),
    );
    return observed.flatMap(({ pull, signals }) => {
      const artifact = readyToMergeArtifact(pull, target.actorLogin, artifacts);
      if (!artifact || !isReadyToMerge(signals)) return [];
      return [
        {
          id: artifact.issue,
          title: pull.title ?? `Pull request #${pull.number}`,
          url: pull.url,
          pr: {
            number: signals.number,
            url: signals.url,
            checks: signals.checks,
            review: signals.review,
            baseDivergence: signals.baseDivergence,
            waitingSinceMillis: signals.waitingSinceMillis,
          },
        },
      ];
    });
  });

  return {
    triggerSources: [makeGitHubPullRequestTriggerSource(client, registry)],
    workflowCatalogContribution: contribution,
    readyToMerge,
    resolvePullRequest,
    openWorkflowPullRequest: (workspace, input) =>
      Effect.gen(function* () {
        const configuredTarget = yield* sourceControlTarget(workspace);
        const target = yield* authenticatedTarget(configuredTarget);
        const existing = yield* client
          .listPulls(target, input.headBranch)
          .pipe(
            Effect.map(
              (pulls) =>
                pulls.find(
                  (pull) =>
                    pull.headRef === input.headBranch &&
                    pull.baseRef === input.baseBranch &&
                    pull.authorLogin === target.actorLogin &&
                    sameRepositoryHead(target, pull),
                ) ?? null,
            ),
          );
        const opened = existing
          ? resolvedPull(workspace, existing)
          : {
              ...(yield* client.createPull(target, {
                ...input,
                body: workflowMarkedBody(input.body, input.origin.writeKey),
              })),
              headBranch: input.headBranch,
              baseBranch: input.baseBranch,
            };
        return workflowArtifact(workspace, opened, input.origin);
      }),
    recordPullRequestPush: (workspace, pullRequest, origin) =>
      Effect.gen(function* () {
        const target = yield* sourceControlTarget(workspace).pipe(Effect.flatMap(authenticatedTarget));
        yield* markPullRequest(target, pullRequest.number, origin.writeKey);
        return workflowArtifact(workspace, pullRequest, origin);
      }),
    commentPullRequest: (workspace, pullRequest, body, origin) =>
      Effect.gen(function* () {
        const target = yield* sourceControlTarget(workspace).pipe(Effect.flatMap(authenticatedTarget));
        if (!(yield* commentsCarry(target, pullRequest.number, origin.writeKey))) {
          yield* client.createComment(target, pullRequest.number, workflowMarkedBody(body, origin.writeKey));
        }
        return workflowArtifact(workspace, pullRequest, origin);
      }),
    requestReview: (workspace, pullRequest, reviewer, origin) =>
      Effect.gen(function* () {
        const target = yield* sourceControlTarget(workspace).pipe(Effect.flatMap(authenticatedTarget));
        const requested = yield* client.listRequestedReviewers(target, pullRequest.number);
        if (!requested.includes(reviewer)) {
          yield* client.requestReview(target, pullRequest.number, reviewer);
        }
        yield* markPullRequest(target, pullRequest.number, origin.writeKey);
        return workflowArtifact(workspace, pullRequest, origin);
      }),
  };
};

export const layer = Layer.effect(
  SourceControlProvider,
  Effect.gen(function* () {
    const client = yield* GitHubClient;
    const registry = yield* WorkspaceRegistry;
    return make(client, registry.state);
  }),
);

export { make as makeProvider };
