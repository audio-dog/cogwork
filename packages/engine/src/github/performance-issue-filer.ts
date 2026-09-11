import { issueTrackerErrorIsPermanent, WorkItemId, type WorkspaceId } from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { IssueTrackerError } from "../issue-tracker";
import {
  make,
  type PerformanceIssue,
  type PerformanceIssueCreateInput,
  PerformanceIssueFiler,
  type PerformanceIssueFilerHost,
  type PerformanceIssueFilerTarget,
  PerformanceIssueFingerprint,
  performanceIssueLabels,
} from "../performance-issue-filer";
import { WorkspaceRegistry, type WorkspaceRegistryService } from "../registry";
import { GitHubClient, type GitHubClientService, type GitHubRepoRef, repoRefFromRepository } from "./client";
import { wireCodec } from "./markers";

const originLabel = "origin:selfperf";

const carriesSelfPerformanceMarker = (body: string | undefined) =>
  wireCodec.scan(body ?? "").some((marker) => marker.name === "selfperf");

const decodeWorkItemId = Schema.decodeSync(WorkItemId);
const decodePerformanceIssueFingerprint = Schema.decodeUnknownOption(PerformanceIssueFingerprint);

const selfPerformanceFingerprint = (body: string | undefined) => {
  const pairs = wireCodec.scan(body ?? "").find((marker) => marker.name === "selfperf")?.pairs;
  if (!pairs?.startsWith("fingerprint=")) return undefined;
  return Option.getOrUndefined(decodePerformanceIssueFingerprint(pairs.slice("fingerprint=".length)));
};

const toPerformanceIssue = (
  issue: Effect.Success<ReturnType<GitHubClientService["listIssues"]>>[number],
  hasMergedFix: boolean,
) =>
  ({
    id: decodeWorkItemId(`#${issue.number}`),
    url: issue.url,
    state: issue.state,
    body: issue.body,
    createdAtMillis: issue.createdAtMillis,
    labels: issue.labels,
    hasMergedFix,
  }) satisfies PerformanceIssue;

const referencesIssue = (body: string, issueNumber: number) =>
  new RegExp(`\\b(?:Refs|Close(?:s|d)?|Fix(?:es|ed)?|Resolve(?:s|d)?)\\s+#${issueNumber}\\b`, "i").test(body);

const mergedFixFor = Effect.fn("github.mergedPerformanceIssueFix")(function* (
  client: Pick<GitHubClientService, "issuePullReferences">,
  repo: GitHubRepoRef,
  issueNumber: number,
) {
  const references = yield* client.issuePullReferences(repo, issueNumber);
  const target = `${repo.owner}/${repo.name}`.toLowerCase();
  return references.some(
    (reference) =>
      reference.merged &&
      reference.repository.toLowerCase() === target &&
      referencesIssue(reference.body, issueNumber),
  );
});

export const performanceIssueHistory = Effect.fn("github.performanceIssueHistory")(function* (
  client: Pick<GitHubClientService, "authenticatedLogin" | "issuePullReferences" | "listIssues">,
  repo: GitHubRepoRef,
) {
  const [all, authenticatedLogin] = yield* Effect.all(
    [client.listIssues(repo, { state: "all" }), client.authenticatedLogin(repo)],
    { concurrency: "unbounded" },
  );
  const relevant = all.filter(
    (issue) =>
      !issue.isPullRequest &&
      (issue.labels.includes(originLabel) ||
        (issue.authorLogin?.toLowerCase() === authenticatedLogin.toLowerCase() &&
          carriesSelfPerformanceMarker(issue.body))),
  );
  const issues = yield* Effect.forEach(
    relevant,
    (issue) =>
      issue.state === "closed"
        ? mergedFixFor(client, repo, issue.number).pipe(
            Effect.map((hasMergedFix) => toPerformanceIssue(issue, hasMergedFix)),
          )
        : Effect.succeed(toPerformanceIssue(issue, false)),
    { concurrency: 5 },
  );
  return issues.toSorted((left, right) => left.createdAtMillis - right.createdAtMillis);
});

const missingTarget = (message: string) =>
  new IssueTrackerError({
    reason: "unavailable",
    retryable: false,
    message,
  });

const retryableUnavailable = (message: string) =>
  new IssueTrackerError({
    reason: "unavailable",
    retryable: true,
    message,
  });

const pendingConfirmation = retryableUnavailable;

const shouldReleaseCreateReservation = (error: IssueTrackerError) => error.writeMayHaveCommitted !== true;

const ensurePerformanceIssueLabels = (
  client: Pick<GitHubClientService, "addLabel">,
  repo: GitHubRepoRef,
  issue: PerformanceIssue,
) =>
  issueNumber(issue.id).pipe(
    Effect.flatMap((number) =>
      Effect.forEach(
        performanceIssueLabels.filter((label) => !issue.labels.includes(label)),
        (label) => client.addLabel(repo, number, label),
        { discard: true },
      ),
    ),
  );

interface PendingCreation {
  readonly fingerprint: PerformanceIssueFingerprint;
  readonly knownIssueIds: ReadonlySet<WorkItemId>;
  readonly target: string;
}

type PendingCreations = ReadonlyMap<string, PendingCreation>;

const targetIdentity = (repo: GitHubRepoRef) => `${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}`;

const pendingKey = (repo: GitHubRepoRef, fingerprint: PerformanceIssueFingerprint) =>
  `${targetIdentity(repo)}:${fingerprint}`;

const clearPendingKey = (pending: PendingCreations, key: string | undefined) =>
  key ? new Map([...pending].filter(([current]) => current !== key)) : pending;

const createdPerformanceIssue = Effect.fn("github.createdPerformanceIssue")(function* (
  client: Pick<GitHubClientService, "authenticatedLogin" | "issuePullReferences" | "listIssues">,
  repo: GitHubRepoRef,
  body: string,
  knownIssueIds: ReadonlySet<WorkItemId>,
) {
  const fingerprint = selfPerformanceFingerprint(body);
  if (!fingerprint) return yield* missingTarget("performance issue fingerprint is missing");
  const history = yield* performanceIssueHistory(client, repo);
  return history
    .filter((issue) => !knownIssueIds.has(issue.id) && selfPerformanceFingerprint(issue.body) === fingerprint)
    .toSorted((left, right) => right.createdAtMillis - left.createdAtMillis)
    .at(0);
});

export const confirmPerformanceIssue = Effect.fn("github.confirmPerformanceIssue")(function* (
  client: Pick<GitHubClientService, "addLabel" | "authenticatedLogin" | "issuePullReferences" | "listIssues">,
  repo: GitHubRepoRef,
  body: string,
  knownIssueIds: ReadonlySet<WorkItemId> = new Set(),
) {
  const created = yield* createdPerformanceIssue(client, repo, body, knownIssueIds);
  if (!created) return yield* pendingConfirmation("created performance issue is not visible yet");
  yield* ensurePerformanceIssueLabels(client, repo, created);
});

const resolvePerformanceIssueTarget = Effect.fn("github.resolvePerformanceIssueTarget")(function* (
  registry: WorkspaceRegistryService,
  workspaceName: WorkspaceId | undefined,
) {
  if (!workspaceName) return yield* missingTarget("performance evidence workspace is not configured");
  const state = yield* registry.state;
  const workspace = state.workspaces.find((candidate) => candidate.config.name === workspaceName);
  if (!workspace)
    return yield* retryableUnavailable(`performance evidence workspace ${workspaceName} is unavailable`);
  if (workspace.config.issueTracker.type !== "github" || !workspace.repository) {
    return yield* missingTarget(`performance evidence workspace ${workspaceName} does not use GitHub issues`);
  }
  const repo = repoRefFromRepository(workspace.repository);
  if (!repo)
    return yield* missingTarget(`performance evidence workspace ${workspaceName} has no GitHub repository`);
  const connectionId = workspace.config.issueTracker.connectionId;
  return {
    ...repo,
    ...(connectionId === "unbound" ? {} : { connectionId }),
  } satisfies GitHubRepoRef;
});

type PerformanceIssueGitHubClient = Pick<
  GitHubClientService,
  | "addLabel"
  | "authenticatedLogin"
  | "createIssue"
  | "createPerformanceComment"
  | "issuePullReferences"
  | "listIssues"
>;

const targetForRepository = (
  client: PerformanceIssueGitHubClient,
  targetRepo: GitHubRepoRef,
  pendingCreations: Ref.Ref<PendingCreations>,
) => {
  const repositoryIdentity = targetIdentity(targetRepo);
  const clearPending = (body: string) =>
    Ref.update(pendingCreations, (pending) => {
      const fingerprint = selfPerformanceFingerprint(body);
      return clearPendingKey(pending, fingerprint ? pendingKey(targetRepo, fingerprint) : undefined);
    });
  const clearAllPending = Ref.set(pendingCreations, new Map());
  const clearPendingOnPermanent = (body: string) => (error: IssueTrackerError) =>
    issueTrackerErrorIsPermanent(error) ? clearPending(body) : Effect.void;
  const confirmCreated = Effect.fn("github.confirmCreatedPerformanceIssue")(function* (
    body: string,
    reservation: PendingCreation,
  ) {
    yield* confirmPerformanceIssue(client, targetRepo, body, reservation.knownIssueIds);
    yield* clearPending(body);
  });
  const confirmPending = Effect.fn("github.confirmPendingPerformanceIssue")(function* (
    issue: PerformanceIssue,
  ) {
    const fingerprint = selfPerformanceFingerprint(issue.body);
    if (!fingerprint) return false;
    const reservation = (yield* Ref.get(pendingCreations)).get(pendingKey(targetRepo, fingerprint));
    if (!reservation || reservation.knownIssueIds.has(issue.id)) return false;
    yield* ensurePerformanceIssueLabels(client, targetRepo, issue).pipe(
      Effect.andThen(clearPending(issue.body)),
      Effect.tapError(clearPendingOnPermanent(issue.body)),
    );
    return true;
  });
  const create = Effect.fn("github.createPerformanceIssue")(function* (input: PerformanceIssueCreateInput) {
    const fingerprint = selfPerformanceFingerprint(input.body);
    if (!fingerprint) return yield* missingTarget("performance issue fingerprint is missing");
    const pending = yield* Ref.get(pendingCreations);
    const key = pendingKey(targetRepo, fingerprint);
    const reservation = pending.get(key);
    if (reservation) {
      return yield* confirmCreated(input.body, reservation).pipe(
        Effect.tapError(clearPendingOnPermanent(input.body)),
      );
    }
    const history = yield* performanceIssueHistory(client, targetRepo);
    const knownIssueIds = new Set(
      history
        .filter((issue) => selfPerformanceFingerprint(issue.body) === fingerprint)
        .map((issue) => issue.id),
    );
    const nextReservation = {
      fingerprint,
      knownIssueIds,
      target: repositoryIdentity,
    } satisfies PendingCreation;
    yield* Ref.update(pendingCreations, (current) => new Map([...current, [key, nextReservation]]));
    yield* client
      .createIssue(targetRepo, input)
      .pipe(
        Effect.tapError((error) =>
          shouldReleaseCreateReservation(error) ? clearPending(input.body) : Effect.void,
        ),
      );
    yield* confirmCreated(input.body, nextReservation).pipe(
      Effect.tapError(clearPendingOnPermanent(input.body)),
    );
  });
  return {
    list: performanceIssueHistory(client, targetRepo).pipe(
      Effect.tapError((error) => (issueTrackerErrorIsPermanent(error) ? clearAllPending : Effect.void)),
    ),
    pendingFingerprints: Ref.get(pendingCreations).pipe(
      Effect.map(
        (pending) =>
          new Set(
            [...pending.values()]
              .filter((reservation) => reservation.target === repositoryIdentity)
              .map((reservation) => reservation.fingerprint),
          ),
      ),
    ),
    create,
    confirmPending,
    comment: Effect.fn("github.performanceIssueComment")(function* (id, body) {
      const number = yield* issueNumber(id);
      yield* client.createPerformanceComment(targetRepo, number, body);
    }),
    ensureLabels: Effect.fn("github.ensurePerformanceIssueLabels")(function* (issue) {
      yield* ensurePerformanceIssueLabels(client, targetRepo, issue).pipe(
        Effect.andThen(clearPending(issue.body)),
        Effect.tapError(clearPendingOnPermanent(issue.body)),
      );
    }),
  } satisfies PerformanceIssueFilerTarget;
};

export const makeTarget = Effect.fn("github.makePerformanceIssueTarget")(function* (
  client: PerformanceIssueGitHubClient,
  repo: GitHubRepoRef,
) {
  const pendingCreations = yield* Ref.make<PendingCreations>(new Map());
  return targetForRepository(client, repo, pendingCreations);
});

const issueNumber = Effect.fn("github.performanceIssueNumber")(function* (id: WorkItemId) {
  const parsed = Number.parseInt(id.replace(/^#/, ""), 10);
  if (!Number.isNaN(parsed)) return parsed;
  return yield* new IssueTrackerError({
    reason: "unavailable",
    retryable: false,
    message: `unrecognized work item id ${id}`,
  });
});

const host = (
  client: GitHubClientService,
  registry: WorkspaceRegistryService,
  workspaceName: WorkspaceId | undefined,
  pendingCreations: Ref.Ref<PendingCreations>,
) =>
  ({
    codec: wireCodec,
    target: resolvePerformanceIssueTarget(registry, workspaceName).pipe(
      Effect.map((repo) => targetForRepository(client, repo, pendingCreations)),
      Effect.tapError((error) =>
        issueTrackerErrorIsPermanent(error) ? Ref.set(pendingCreations, new Map()) : Effect.void,
      ),
    ),
  }) satisfies PerformanceIssueFilerHost;

export const layer = (workspaceName: WorkspaceId | undefined) =>
  Layer.effect(
    PerformanceIssueFiler,
    Effect.gen(function* () {
      const client = yield* GitHubClient;
      const registry = yield* WorkspaceRegistry;
      const pendingCreations = yield* Ref.make<PendingCreations>(new Map());
      return yield* make(host(client, registry, workspaceName, pendingCreations));
    }),
  );
