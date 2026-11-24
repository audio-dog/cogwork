import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { CheckRun } from "../ci";
import type { IssueTrackerError } from "../issue-tracker";
import type { OpenPullRequestInput } from "../source-control";
import type {
  CreateReviewInput,
  GitHubRepoRef,
  RawIssuePullReference,
  RawPull,
  RawPullDetail,
  RawReview,
  RawReviewComment,
} from "./client";
import {
  closingReferencesCursor,
  closingReferencesFor,
  closingReferencesQuery,
  decodeClosingReferences,
  decodeIssuePullReferences,
  issuePullReferencesPage,
  issuePullReferencesQuery,
} from "./client-graphql";
import {
  actionsJobIdOf,
  commentMillis,
  decodeCheckRuns,
  decodeCompare,
  decodeCreatedPull,
  decodeCreatedPulls,
  decodePullDetail,
  decodePulls,
  decodeReviewComments,
  decodeReviews,
  millisFromIso,
  openedPull,
  PullMergeableStateSchema,
  type PullSchema,
  RequestedReviewersSchema,
  toRawReviewComment,
} from "./client-responses";
import {
  type GitHubTransport,
  repoPath,
  toUnavailable,
  unavailable,
  withPaginationDeadline,
  withTransientRetry,
} from "./client-transport";

const openPullsPath = (repo: GitHubRepoRef, headBranch?: string) => {
  if (!headBranch) return "/pulls?state=open&per_page=100&sort=updated&direction=desc";
  const head = encodeURIComponent(`${repo.owner}:${headBranch}`);
  return `/pulls?state=open&head=${head}&per_page=100`;
};

const comparePath = (repo: GitHubRepoRef, baseSha: string, headSha: string) =>
  repoPath(repo, `/compare/${encodeURIComponent(baseSha)}...${encodeURIComponent(headSha)}`);

export const makePullClient = (transport: GitHubTransport) => {
  const {
    fetchJson,
    fetchJsonResponse,
    graphql,
    linkedPageNumber,
    send,
    sendAcceptedJsonOnce,
    sendAcceptedOnce,
    sendJson,
  } = transport;

  const nextPullPageUrl = Effect.fn("github.nextPullPageUrl")(function* (
    repo: GitHubRepoRef,
    header: string | undefined,
  ) {
    const expectedPath = `/repos/${repo.owner}/${repo.name}/pulls`;
    const canonicalPath = /^\/repositories\/[1-9]\d*\/pulls$/;
    const page = yield* linkedPageNumber(header, expectedPath, canonicalPath, "pull");
    return page === null ? null : repoPath(repo, `${openPullsPath(repo)}&page=${page}`);
  });

  const fetchPullPage = Effect.fn("github.fetchPullPage")(function* (repo: GitHubRepoRef, path: string) {
    const response = yield* fetchJsonResponse(repo, path);
    const nextUrl = yield* nextPullPageUrl(repo, response.nextLink ?? undefined);
    return { pulls: yield* Effect.mapError(decodePulls(response.body), toUnavailable), nextUrl };
  });

  const collectPullPages: (
    repo: GitHubRepoRef,
    path: string,
    visited?: ReadonlySet<string>,
  ) => Effect.Effect<ReadonlyArray<typeof PullSchema.Type>, IssueTrackerError> = Effect.fn(
    "github.collectPullPages",
  )(function* (repo, path, visited = new Set()) {
    if (visited.has(path)) {
      return yield* unavailable("GitHub pull pagination returned a repeated next link");
    }
    const page = yield* fetchPullPage(repo, path);
    if (page.nextUrl === null) return page.pulls;
    const remaining = yield* collectPullPages(repo, page.nextUrl, new Set(visited).add(path));
    return [...page.pulls, ...remaining];
  });

  const uniquePulls = (pulls: ReadonlyArray<typeof PullSchema.Type>) => [
    ...new Map(pulls.map((pull) => [pull.number, pull])).values(),
  ];

  const readPulls = Effect.fn("github.readPulls")(function* (repo: GitHubRepoRef, headBranch?: string) {
    const path = repoPath(repo, openPullsPath(repo, headBranch));
    if (headBranch) {
      const json = yield* fetchJson(repo, path);
      return yield* Effect.mapError(decodePulls(json), toUnavailable);
    }
    const pulls = yield* withPaginationDeadline(collectPullPages(repo, path));
    return uniquePulls(pulls);
  });

  const listReviews = Effect.fn("github.listReviews")(function* (repo: GitHubRepoRef, pullNumber: number) {
    const collect: (page?: number) => Effect.Effect<ReadonlyArray<RawReview>, IssueTrackerError> = Effect.fn(
      "github.collectReviewPages",
    )(function* (page = 1) {
      const json = yield* fetchJson(
        repo,
        repoPath(repo, `/pulls/${pullNumber}/reviews?per_page=100&page=${page}`),
      );
      const reviews = yield* Effect.mapError(decodeReviews(json), toUnavailable);
      const current = reviews.flatMap(({ user, ...review }): ReadonlyArray<RawReview> => {
        if (user === null) return [];
        return [
          {
            id: review.id,
            authorLogin: user.login,
            authorAssociation: review.author_association ?? "NONE",
            ...(user.type ? { authorType: user.type } : {}),
            state: review.state,
            body: review.body ?? "",
            submittedAtMillis: review.submitted_at ? commentMillis(review.submitted_at) : 0,
          },
        ];
      });
      if (reviews.length < 100) return current;
      return [...current, ...(yield* collect(page + 1))];
    });
    return yield* withPaginationDeadline(collect());
  });

  const listReviewComments = Effect.fn("github.listReviewComments")(function* (
    repo: GitHubRepoRef,
    pullNumber: number,
  ) {
    const collect: (page?: number) => Effect.Effect<ReadonlyArray<RawReviewComment>, IssueTrackerError> =
      Effect.fn("github.collectReviewCommentPages")(function* (page = 1) {
        const json = yield* fetchJson(
          repo,
          repoPath(
            repo,
            `/pulls/${pullNumber}/comments?per_page=100&sort=created&direction=desc&page=${page}`,
          ),
        );
        const comments = yield* Effect.mapError(decodeReviewComments(json), toUnavailable);
        const current = comments.flatMap(toRawReviewComment);
        if (comments.length < 100) return current;
        return [...current, ...(yield* collect(page + 1))];
      });
    return yield* withPaginationDeadline(collect());
  });

  const recoverCreatedPull = Effect.fn("github.recoverCreatedPull")(function* (
    repo: GitHubRepoRef,
    input: OpenPullRequestInput,
  ) {
    const query = new URLSearchParams({
      state: "open",
      head: `${repo.owner}:${input.headBranch}`,
      base: input.baseBranch,
      per_page: "1",
    });
    const json = yield* fetchJson(repo, repoPath(repo, `/pulls?${query}`));
    const [created] = yield* Effect.mapError(decodeCreatedPulls(json), toUnavailable);
    if (!created) {
      return yield* unavailable(
        "GitHub accepted pull request creation but no matching pull request was found",
      );
    }
    return openedPull(created);
  });

  const createPull = Effect.fn("github.createPull")(function* (
    repo: GitHubRepoRef,
    input: OpenPullRequestInput,
  ) {
    const acceptedBody = yield* sendAcceptedJsonOnce(repo, HttpClientRequest.post(repoPath(repo, "/pulls")), {
      head: input.headBranch,
      base: input.baseBranch,
      title: input.title,
      body: input.body,
    });
    if (Option.isNone(acceptedBody)) {
      return yield* recoverCreatedPull(repo, input);
    }
    const created = yield* Effect.mapError(decodeCreatedPull(acceptedBody.value), toUnavailable);
    return openedPull(created);
  });

  const collectClosingReferencePages: (
    repo: GitHubRepoRef,
    cursor?: string | null,
  ) => Effect.Effect<ReadonlyMap<number, ReadonlyArray<number>>, IssueTrackerError> = Effect.fn(
    "github.collectClosingReferencePages",
  )(function* (repo: GitHubRepoRef, cursor: string | null = null) {
    const data = yield* graphql(repo, closingReferencesQuery, {
      owner: repo.owner,
      name: repo.name,
      cursor,
    });
    const payload = yield* Effect.mapError(decodeClosingReferences(data), toUnavailable);
    const nextCursor = closingReferencesCursor(payload);
    const current = closingReferencesFor(repo, payload);
    if (nextCursor === null) return current;
    const remaining = yield* collectClosingReferencePages(repo, nextCursor);
    return new Map([...current, ...remaining]);
  });

  const pullClosingReferences = Effect.fn("github.pullClosingReferences")(function* (repo: GitHubRepoRef) {
    return yield* withPaginationDeadline(collectClosingReferencePages(repo));
  });

  const collectIssuePullReferencePages: (
    repo: GitHubRepoRef,
    issueNumber: number,
    cursor?: string | null,
  ) => Effect.Effect<ReadonlyArray<RawIssuePullReference>, IssueTrackerError> = Effect.fn(
    "github.collectIssuePullReferencePages",
  )(function* (repo, issueNumber, cursor = null) {
    const data = yield* graphql(repo, issuePullReferencesQuery, {
      owner: repo.owner,
      name: repo.name,
      number: issueNumber,
      cursor,
    });
    const payload = yield* Effect.mapError(decodeIssuePullReferences(data), toUnavailable);
    const page = issuePullReferencesPage(payload);
    if (page.nextCursor === null) return page.references;
    const remaining = yield* collectIssuePullReferencePages(repo, issueNumber, page.nextCursor);
    return [...page.references, ...remaining];
  });

  const issuePullReferences = Effect.fn("github.issuePullReferences")(function* (
    repo: GitHubRepoRef,
    issueNumber: number,
  ) {
    return yield* withPaginationDeadline(collectIssuePullReferencePages(repo, issueNumber));
  });

  const pullReferences = (repo: GitHubRepoRef, headBranch?: string) =>
    headBranch ? Effect.succeed(new Map<number, ReadonlyArray<number>>()) : pullClosingReferences(repo);

  const listRequestedReviewers = Effect.fn("github.listRequestedReviewers")(function* (
    repo: GitHubRepoRef,
    pullNumber: number,
  ) {
    const json = yield* fetchJson(
      repo,
      repoPath(repo, `/pulls/${pullNumber}/requested_reviewers?per_page=100`),
    );
    const response = yield* Effect.mapError(
      Schema.decodeUnknownEffect(RequestedReviewersSchema)(json),
      toUnavailable,
    );
    return response.users.map(({ login }) => login);
  });

  const requestReview = Effect.fn("github.requestReview")(function* (
    repo: GitHubRepoRef,
    pullNumber: number,
    reviewer: string,
  ) {
    yield* sendJson(
      repo,
      HttpClientRequest.post(repoPath(repo, `/pulls/${pullNumber}/requested_reviewers`)),
      { reviewers: [reviewer] },
    );
  });

  const createReview = Effect.fn("github.createReview")(function* (
    repo: GitHubRepoRef,
    pullNumber: number,
    input: CreateReviewInput,
  ) {
    yield* sendAcceptedOnce(repo, HttpClientRequest.post(repoPath(repo, `/pulls/${pullNumber}/reviews`)), {
      commit_id: input.commitId,
      body: input.body,
      comments: input.comments.map((comment) => ({ ...comment, side: "RIGHT" })),
      ...(input.event === null ? {} : { event: input.event }),
    });
  });

  const getPull = Effect.fn("github.getPull")(function* (repo: GitHubRepoRef, pullNumber: number) {
    const json = yield* fetchJson(repo, repoPath(repo, `/pulls/${pullNumber}`));
    const pull = yield* Effect.mapError(decodePullDetail(json), toUnavailable);
    return {
      number: pull.number,
      url: pull.html_url || `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
      authorLogin: pull.user.login,
      authorAssociation: pull.author_association ?? "NONE",
      draft: pull.draft ?? false,
      headSha: pull.head.sha,
      baseSha: pull.base?.sha,
      baseRef: pull.base?.ref,
      headRef: pull.head.ref,
      headRepository: pull.head.repo?.full_name ?? null,
      closingIssueNumbers: [] as ReadonlyArray<number>,
      updatedAtMillis: millisFromIso(pull.updated_at ?? null),
      title: pull.title,
      body: pull.body ?? "",
      mergeableState: pull.mergeable_state ?? null,
    } satisfies RawPullDetail;
  });

  const listPullFiles = Effect.fn("github.listPullFiles")(function* (
    repo: GitHubRepoRef,
    baseSha: string,
    headSha: string,
  ) {
    const json = yield* fetchJson(repo, comparePath(repo, baseSha, headSha));
    const comparison = yield* Effect.mapError(decodeCompare(json), toUnavailable);
    return comparison.files.map((file) => ({
      path: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      patch: file.patch ?? null,
    }));
  });

  return {
    listPulls: Effect.fn("github.listPulls")(function* (repo: GitHubRepoRef, headBranch?: string) {
      const pulls = yield* readPulls(repo, headBranch);
      const references = yield* pullReferences(repo, headBranch);
      return pulls.map((pull): RawPull => ({
        number: pull.number,
        title: pull.title,
        url: pull.html_url || `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
        authorLogin: pull.user.login,
        authorAssociation: pull.author_association ?? "NONE",
        draft: pull.draft ?? false,
        headSha: pull.head.sha,
        baseSha: pull.base?.sha,
        headRef: pull.head.ref,
        headRepository: pull.head.repo?.full_name ?? null,
        ...(pull.base?.ref ? { baseRef: pull.base.ref } : {}),
        closingIssueNumbers: references.get(pull.number) ?? [],
        updatedAtMillis: millisFromIso(pull.updated_at ?? null),
      }));
    }),
    getPull,
    getPullDiff: Effect.fn("github.getPullDiff")(function* (
      repo: GitHubRepoRef,
      baseSha: string,
      headSha: string,
    ) {
      return yield* withTransientRetry(
        send(
          repo,
          HttpClientRequest.get(comparePath(repo, baseSha, headSha)).pipe(
            HttpClientRequest.setHeader("accept", "application/vnd.github.v3.diff"),
          ),
          (response) => response.text,
        ),
      );
    }),
    listPullFiles,
    issuePullReferences,
    pullMergeableState: (repo: GitHubRepoRef, pullNumber: number) =>
      Effect.gen(function* () {
        const json = yield* fetchJson(repo, repoPath(repo, `/pulls/${pullNumber}`));
        const detail = yield* Effect.mapError(
          Schema.decodeUnknownEffect(PullMergeableStateSchema)(json),
          toUnavailable,
        );
        return detail.mergeable_state ?? null;
      }),
    listReviewComments,
    listReviews,
    listCheckRuns: (repo: GitHubRepoRef, sha: string) => {
      const collect: (page?: number) => Effect.Effect<ReadonlyArray<CheckRun>, IssueTrackerError> = Effect.fn(
        "github.collectCheckRunPages",
      )(function* (page = 1) {
        const json = yield* fetchJson(
          repo,
          repoPath(repo, `/commits/${sha}/check-runs?per_page=100&page=${page}`),
        );
        const decoded = yield* Effect.mapError(decodeCheckRuns(json), toUnavailable);
        const current = decoded.check_runs.map((run): CheckRun => ({
          name: run.name,
          status: run.status,
          conclusion: run.conclusion,
          startedAtMillis: millisFromIso(run.started_at),
          completedAtMillis: millisFromIso(run.completed_at),
          detailsUrl: run.details_url ?? null,
          outputTitle: run.output?.title ?? null,
          outputSummary: run.output?.summary ?? null,
          actionsJobId: actionsJobIdOf(run),
        }));
        if (current.length < 100) return current;
        return [...current, ...(yield* collect(page + 1))];
      });
      return withPaginationDeadline(collect());
    },
    createPull,
    listRequestedReviewers,
    requestReview,
    createReview,
  };
};
