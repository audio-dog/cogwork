import { WorkItemId } from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { IssueTracker, IssueTrackerError, type IssueTrackerService } from "../issue-tracker";
import {
  make,
  PerformanceIssueFiler,
  type PerformanceIssueFilerHost,
  type PerformanceIssueFilerTarget,
} from "../performance-issue-filer";
import { WorkspaceRegistry, type WorkspaceRegistryService } from "../registry";
import { GitHubClient, type GitHubClientService, type GitHubRepoRef, repoRefFromRepository } from "./client";
import { wireCodec } from "./markers";

const originLabel = "origin:selfperf";

const performanceWorkspaces = Effect.fn("github.performanceIssueWorkspaces")(function* (
  registry: WorkspaceRegistryService,
) {
  const state = yield* registry.state;
  return state.workspaces.filter(
    (workspace) => workspace.config.issueTracker.type === "github" && workspace.repository !== undefined,
  );
});

const missingTarget = (count: number) =>
  new IssueTrackerError({
    reason: "unavailable",
    retryable: false,
    message:
      count === 0
        ? "no GitHub workspace is available for performance evidence"
        : "multiple GitHub workspaces are available for performance evidence",
  });

const targetFor = Effect.fn("github.performanceIssueTarget")(function* (
  client: GitHubClientService,
  tracker: IssueTrackerService,
  registry: WorkspaceRegistryService,
) {
  const workspaces = yield* performanceWorkspaces(registry);
  if (workspaces.length !== 1) return yield* missingTarget(workspaces.length);
  const [workspace] = workspaces;
  if (!workspace?.repository) return yield* missingTarget(0);
  const repo = repoRefFromRepository(workspace.repository);
  if (!repo) return yield* missingTarget(0);
  const connectionId = workspace.config.issueTracker.connectionId;
  const targetRepo = {
    ...repo,
    ...(connectionId === "unbound" ? {} : { connectionId }),
  } satisfies GitHubRepoRef;
  return {
    list: client.listIssues(targetRepo, { state: "all", label: originLabel }).pipe(
      Effect.map((issues) =>
        issues
          .filter((issue) => !issue.isPullRequest)
          .map((issue) => ({
            id: `#${issue.number}`,
            url: issue.url,
            state: issue.state ?? "open",
            body: issue.body ?? "",
            createdAtMillis: issue.createdAtMillis ?? 0,
          })),
      ),
    ),
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
) =>
  ({
    codec: wireCodec,
    target: targetFor(client, tracker, registry),
  }) satisfies PerformanceIssueFilerHost;

export const layer = Layer.effect(
  PerformanceIssueFiler,
  Effect.gen(function* () {
    const client = yield* GitHubClient;
    const tracker = yield* IssueTracker;
    const registry = yield* WorkspaceRegistry;
    return yield* make(host(client, tracker, registry));
  }),
);
