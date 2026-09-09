import { WorkItemId, type WorkspaceId } from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { IssueTracker, IssueTrackerError, type IssueTrackerService } from "../issue-tracker";
import {
  make,
  type PerformanceIssue,
  PerformanceIssueFiler,
  type PerformanceIssueFilerHost,
  type PerformanceIssueFilerTarget,
} from "../performance-issue-filer";
import { WorkspaceRegistry, type WorkspaceRegistryService } from "../registry";
import { GitHubClient, type GitHubClientService, type GitHubRepoRef, repoRefFromRepository } from "./client";
import { wireCodec } from "./markers";

const originLabel = "origin:selfperf";

const carriesSelfPerformanceMarker = (body: string | undefined) =>
  wireCodec.scan(body ?? "").some((marker) => marker.name === "selfperf");

const toPerformanceIssue = (issue: Effect.Success<ReturnType<GitHubClientService["listIssues"]>>[number]) =>
  ({
    id: `#${issue.number}`,
    url: issue.url,
    state: issue.state ?? "open",
    body: issue.body ?? "",
    createdAtMillis: issue.createdAtMillis ?? 0,
  }) satisfies PerformanceIssue;

export const performanceIssueHistory = Effect.fn("github.performanceIssueHistory")(function* (
  client: Pick<GitHubClientService, "listIssues">,
  repo: GitHubRepoRef,
) {
  const [labeled, open] = yield* Effect.all([
    client.listIssues(repo, { state: "all", label: originLabel }),
    client.listIssues(repo, { state: "open" }),
  ]);
  const relevantOpen = open.filter((issue) => carriesSelfPerformanceMarker(issue.body));
  const unique = new Map([...labeled, ...relevantOpen].map((issue) => [issue.number, issue]));
  return [...unique.values()].filter((issue) => !issue.isPullRequest).map(toPerformanceIssue);
});

const missingTarget = (message: string) =>
  new IssueTrackerError({
    reason: "unavailable",
    retryable: false,
    message,
  });

const targetFor = Effect.fn("github.performanceIssueTarget")(function* (
  client: GitHubClientService,
  tracker: IssueTrackerService,
  registry: WorkspaceRegistryService,
  workspaceName: WorkspaceId | undefined,
) {
  if (!workspaceName) return yield* missingTarget("performance evidence workspace is not configured");
  const state = yield* registry.state;
  const workspace = state.workspaces.find((candidate) => candidate.config.name === workspaceName);
  if (!workspace)
    return yield* missingTarget(`performance evidence workspace ${workspaceName} is unavailable`);
  if (workspace.config.issueTracker.type !== "github" || !workspace.repository) {
    return yield* missingTarget(`performance evidence workspace ${workspaceName} does not use GitHub issues`);
  }
  const repo = repoRefFromRepository(workspace.repository);
  if (!repo)
    return yield* missingTarget(`performance evidence workspace ${workspaceName} has no GitHub repository`);
  const connectionId = workspace.config.issueTracker.connectionId;
  const targetRepo = {
    ...repo,
    ...(connectionId === "unbound" ? {} : { connectionId }),
  } satisfies GitHubRepoRef;
  return {
    list: performanceIssueHistory(client, targetRepo),
    create: (input) => tracker.createIssue(workspace, input),
    comment: (id, body) =>
      itemId(id).pipe(Effect.flatMap((workItemId) => tracker.note(workspace, workItemId, body))),
  } satisfies PerformanceIssueFilerTarget;
});

const decodeItemId = Schema.decodeUnknownEffect(WorkItemId);

const itemId = (id: string) => decodeItemId(id).pipe(Effect.orDie);

const host = (
  client: GitHubClientService,
  tracker: IssueTrackerService,
  registry: WorkspaceRegistryService,
  workspaceName: WorkspaceId | undefined,
) =>
  ({
    codec: wireCodec,
    target: targetFor(client, tracker, registry, workspaceName),
  }) satisfies PerformanceIssueFilerHost;

export const layer = (workspaceName: WorkspaceId | undefined) =>
  Layer.effect(
    PerformanceIssueFiler,
    Effect.gen(function* () {
      const client = yield* GitHubClient;
      const tracker = yield* IssueTracker;
      const registry = yield* WorkspaceRegistry;
      return yield* make(host(client, tracker, registry, workspaceName));
    }),
  );
