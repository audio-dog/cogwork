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
import { WorkspaceRegistry, type WorkspaceRegistryService } from "../registry-service";
import { GitHubClient, type GitHubClientService, type GitHubRepoRef, repoRefFromRepository } from "./client";
import { wireCodec } from "./markers";

const originLabel = "origin:selfperf";
type MarkerTrust = "authenticated-author" | "origin-label-only";

const decodeWorkItemId = Schema.decodeSync(WorkItemId);
const decodePerformanceIssueFingerprint = Schema.decodeUnknownOption(PerformanceIssueFingerprint);

const decodeSelfPerformanceFingerprint = (body: string | undefined) => {
  const pairs = wireCodec.scan(body ?? "").find((marker) => marker.name === "selfperf")?.pairs;
  if (!pairs?.startsWith("fingerprint=")) return undefined;
  return Option.getOrUndefined(decodePerformanceIssueFingerprint(pairs.slice("fingerprint=".length)));
};

const toPerformanceIssue = (
  issue: Effect.Success<ReturnType<GitHubClientService["listIssues"]>>[number],
  fingerprint: PerformanceIssueFingerprint | undefined,
  hasMergedFix: boolean,
) =>
  ({
    id: decodeWorkItemId(`#${issue.number}`),
    url: issue.url,
    state: issue.state,
    fingerprint,
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
  markerTrust: MarkerTrust = "authenticated-author",
) {
  const all = yield* client.listIssues(repo, { state: "all" });
  const candidates = all
    .filter((issue) => !issue.isPullRequest)
    .map((issue) => ({ issue, fingerprint: decodeSelfPerformanceFingerprint(issue.body) }));
  const shouldAuthenticateMarker =
    markerTrust === "authenticated-author" &&
    candidates.some(
      ({ issue, fingerprint }) => !issue.labels.includes(originLabel) && fingerprint !== undefined,
    );
  const authenticatedLogin = yield* shouldAuthenticateMarker
    ? client.authenticatedLogin(repo).pipe(Effect.map((login) => login.toLowerCase()))
    : Effect.void;
  const relevant = candidates.filter(({ issue, fingerprint }) => {
    const hasOriginLabel = issue.labels.includes(originLabel);
    const hasTrustedMarker =
      authenticatedLogin !== undefined &&
      fingerprint !== undefined &&
      issue.authorLogin?.toLowerCase() === authenticatedLogin;
    return hasOriginLabel || hasTrustedMarker;
  });
  const issues = yield* Effect.forEach(
    relevant,
    ({ issue, fingerprint }) =>
      issue.state === "closed"
        ? mergedFixFor(client, repo, issue.number).pipe(
            Effect.map((hasMergedFix) => toPerformanceIssue(issue, fingerprint, hasMergedFix)),
          )
        : Effect.succeed(toPerformanceIssue(issue, fingerprint, false)),
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

const clearPendingKey = (pending: PendingCreations, key: string) =>
  new Map([...pending].filter(([current]) => current !== key));

const createdPerformanceIssue = Effect.fn("github.createdPerformanceIssue")(function* (
  client: Pick<GitHubClientService, "authenticatedLogin" | "issuePullReferences" | "listIssues">,
  repo: GitHubRepoRef,
  fingerprint: PerformanceIssueFingerprint,
  knownIssueIds: ReadonlySet<WorkItemId>,
  markerTrust: MarkerTrust,
) {
  const history = yield* performanceIssueHistory(client, repo, markerTrust);
  return history
    .filter((issue) => !knownIssueIds.has(issue.id) && issue.fingerprint === fingerprint)
    .toSorted((left, right) => right.createdAtMillis - left.createdAtMillis)
    .at(0);
});

export const confirmPerformanceIssue = Effect.fn("github.confirmPerformanceIssue")(function* (
  client: Pick<GitHubClientService, "addLabel" | "authenticatedLogin" | "issuePullReferences" | "listIssues">,
  repo: GitHubRepoRef,
  fingerprint: PerformanceIssueFingerprint,
  knownIssueIds: ReadonlySet<WorkItemId> = new Set(),
  markerTrust: MarkerTrust = "authenticated-author",
) {
  const created = yield* createdPerformanceIssue(client, repo, fingerprint, knownIssueIds, markerTrust);
  if (!created) return yield* pendingConfirmation("created performance issue is not visible yet");
  yield* ensurePerformanceIssueLabels(client, repo, created);
});

const resolvePerformanceIssueTarget = Effect.fn("github.resolvePerformanceIssueTarget")(function* (
  registry: WorkspaceRegistryService,
  workspaceId: WorkspaceId | undefined,
) {
  if (!workspaceId) return yield* missingTarget("performance evidence workspace is not configured");
  const state = yield* registry.state;
  const workspace = state.workspaces.find((candidate) => candidate.config.id === workspaceId);
  if (!workspace)
    return yield* retryableUnavailable(`performance evidence workspace ${workspaceId} is unavailable`);
  if (workspace.config.issueTracker.type !== "github" || !workspace.repository) {
    return yield* missingTarget(`performance evidence workspace ${workspaceId} does not use GitHub issues`);
  }
  const repo = repoRefFromRepository(workspace.repository);
  if (!repo)
    return yield* missingTarget(`performance evidence workspace ${workspaceId} has no GitHub repository`);
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
  markerTrust: MarkerTrust,
) => {
  const repositoryIdentity = targetIdentity(targetRepo);
  const clearPending = (fingerprint: PerformanceIssueFingerprint) =>
    Ref.update(pendingCreations, (pending) => clearPendingKey(pending, pendingKey(targetRepo, fingerprint)));
  const clearAllPending = Ref.set(pendingCreations, new Map());
  const clearPendingOnPermanent = (fingerprint: PerformanceIssueFingerprint) => (error: IssueTrackerError) =>
    issueTrackerErrorIsPermanent(error) ? clearPending(fingerprint) : Effect.void;
  const confirmCreated = Effect.fn("github.confirmCreatedPerformanceIssue")((reservation: PendingCreation) =>
    confirmPerformanceIssue(
      client,
      targetRepo,
      reservation.fingerprint,
      reservation.knownIssueIds,
      markerTrust,
    ).pipe(Effect.andThen(clearPending(reservation.fingerprint))),
  );
  const confirmPending = Effect.fn("github.confirmPendingPerformanceIssue")(function* (
    issue: PerformanceIssue,
  ) {
    if (!issue.fingerprint) return false;
    const reservation = (yield* Ref.get(pendingCreations)).get(pendingKey(targetRepo, issue.fingerprint));
    if (!reservation || reservation.knownIssueIds.has(issue.id)) return false;
    yield* ensurePerformanceIssueLabels(client, targetRepo, issue).pipe(
      Effect.andThen(clearPending(issue.fingerprint)),
      Effect.tapError(clearPendingOnPermanent(issue.fingerprint)),
    );
    return true;
  });
  const create = Effect.fn("github.createPerformanceIssue")(function* (input: PerformanceIssueCreateInput) {
    const pending = yield* Ref.get(pendingCreations);
    const key = pendingKey(targetRepo, input.fingerprint);
    const reservation = pending.get(key);
    if (reservation) {
      return yield* confirmCreated(reservation).pipe(
        Effect.tapError(clearPendingOnPermanent(input.fingerprint)),
      );
    }
    const history = yield* performanceIssueHistory(client, targetRepo, markerTrust);
    const knownIssueIds = new Set(
      history.filter((issue) => issue.fingerprint === input.fingerprint).map((issue) => issue.id),
    );
    const nextReservation = {
      fingerprint: input.fingerprint,
      knownIssueIds,
      target: repositoryIdentity,
    } satisfies PendingCreation;
    yield* Ref.update(pendingCreations, (current) => new Map([...current, [key, nextReservation]]));
    yield* client
      .createIssue(targetRepo, input)
      .pipe(
        Effect.tapError((error) =>
          shouldReleaseCreateReservation(error) ? clearPending(input.fingerprint) : Effect.void,
        ),
      );
    yield* confirmCreated(nextReservation).pipe(Effect.tapError(clearPendingOnPermanent(input.fingerprint)));
  });
  return {
    list: performanceIssueHistory(client, targetRepo, markerTrust).pipe(
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
    comment: Effect.fn("github.performanceIssueComment")((id, body) =>
      issueNumber(id).pipe(
        Effect.flatMap((number) => client.createPerformanceComment(targetRepo, number, body)),
      ),
    ),
    ensureLabels: Effect.fn("github.ensurePerformanceIssueLabels")((issue) => {
      const ensured = ensurePerformanceIssueLabels(client, targetRepo, issue);
      if (!issue.fingerprint) return ensured;
      return ensured.pipe(
        Effect.andThen(clearPending(issue.fingerprint)),
        Effect.tapError(clearPendingOnPermanent(issue.fingerprint)),
      );
    }),
  } satisfies PerformanceIssueFilerTarget;
};

export const makeTarget = Effect.fn("github.makePerformanceIssueTarget")(function* (
  client: PerformanceIssueGitHubClient,
  repo: GitHubRepoRef,
  markerTrust: MarkerTrust = "authenticated-author",
) {
  const pendingCreations = yield* Ref.make<PendingCreations>(new Map());
  return targetForRepository(client, repo, pendingCreations, markerTrust);
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
  workspaceId: WorkspaceId | undefined,
  pendingCreations: Ref.Ref<PendingCreations>,
) =>
  ({
    codec: wireCodec,
    target: resolvePerformanceIssueTarget(registry, workspaceId).pipe(
      Effect.map((repo) => targetForRepository(client, repo, pendingCreations, "authenticated-author")),
      Effect.tapError((error) =>
        issueTrackerErrorIsPermanent(error) ? Ref.set(pendingCreations, new Map()) : Effect.void,
      ),
    ),
  }) satisfies PerformanceIssueFilerHost;

export const layer = (workspaceId: WorkspaceId | undefined) =>
  Layer.effect(
    PerformanceIssueFiler,
    Effect.gen(function* () {
      const client = yield* GitHubClient;
      const registry = yield* WorkspaceRegistry;
      const pendingCreations = yield* Ref.make<PendingCreations>(new Map());
      return yield* make(host(client, registry, workspaceId, pendingCreations));
    }),
  );
