import {
  type ConnectionId,
  connectionAccountOf,
  type GitHubPrioritySource,
  type Priority,
} from "@cogwork/contracts";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Headers from "effect/unstable/http/Headers";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import type { CheckRun } from "../ci";
import { CredentialStore } from "../credential-store";
import { type CreateIssueInput, defaultTrackerCooldown, IssueTrackerError } from "../issue-tracker";
import type { OpenedPullRequest, OpenPullRequestInput } from "../source-control";
import {
  boardMissing,
  decodeProjectPriorities,
  defaultPriorityField,
  pageOf,
  priorityQuery,
} from "./priority";

export interface GitHubRepoRef {
  readonly owner: string;
  readonly name: string;
  readonly tokenEnv: string;
  readonly connectionId?: ConnectionId;
}

export type ReviewDecision = "changes-requested" | "approved" | "none";

export interface RawIssue {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly labels: ReadonlyArray<string>;
  readonly assignees: ReadonlyArray<string>;
  readonly isPullRequest: boolean;
  readonly openBlockers: number;
}

export interface RawPull {
  readonly number: number;
  readonly url: string;
  readonly authorLogin: string;
  readonly authorAssociation: string;
  readonly draft: boolean;
  readonly headSha: string;
  readonly headRef: string;
  readonly headRepository: string | null;
  readonly closingIssueNumbers: ReadonlyArray<number>;
  readonly updatedAtMillis: number;
}

export interface RawComment {
  readonly id: number;
  readonly authorLogin: string;
  readonly authorAssociation: string;
  readonly body: string;
  readonly createdAtMillis: number;
}

export interface RawReview {
  readonly authorLogin: string;
  readonly authorAssociation: string;
  readonly state: string;
  readonly body: string;
  readonly submittedAtMillis: number;
}

const baseHeaders = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "cogwork",
};

const LabelName = Schema.Union([Schema.String, Schema.Struct({ name: Schema.String })]);
const labelName = (label: typeof LabelName.Type) => (typeof label === "string" ? label : label.name);

// GitHub reports `blocked_by` as open blockers only; `total_blocked_by` counts closed ones too.
const DependenciesSummarySchema = Schema.Struct({
  blocked_by: Schema.optional(Schema.NullOr(Schema.Natural)),
});

const IssueSchema = Schema.Struct({
  number: Schema.Finite,
  title: Schema.String,
  html_url: Schema.optional(Schema.NullOr(Schema.String)),
  labels: Schema.Array(LabelName),
  assignees: Schema.optional(Schema.Array(Schema.Struct({ login: Schema.String }))),
  pull_request: Schema.optional(Schema.Unknown),
  issue_dependencies_summary: Schema.optional(Schema.NullOr(DependenciesSummarySchema)),
});

const CreatedIssueSchema = Schema.Struct({
  number: Schema.Finite,
  labels: Schema.Array(LabelName),
});

const CreatedPullSchema = Schema.Struct({
  number: Schema.Finite,
  html_url: Schema.String,
});

const PullSchema = Schema.Struct({
  number: Schema.Finite,
  html_url: Schema.optional(Schema.NullOr(Schema.String)),
  user: Schema.Struct({ login: Schema.String }),
  draft: Schema.optional(Schema.Boolean),
  head: Schema.Struct({
    sha: Schema.String,
    ref: Schema.String,
    repo: Schema.optional(Schema.NullOr(Schema.Struct({ full_name: Schema.String }))),
  }),
  author_association: Schema.optional(Schema.String),
  updated_at: Schema.optional(Schema.NullOr(Schema.String)),
});

const PullDetailSchema = Schema.Struct({
  mergeable_state: Schema.optional(Schema.NullOr(Schema.String)),
});

const ReviewSchema = Schema.Struct({
  state: Schema.String,
  user: Schema.Struct({ login: Schema.String }),
  body: Schema.NullOr(Schema.String),
  author_association: Schema.optional(Schema.String),
  submitted_at: Schema.optional(Schema.NullOr(Schema.String)),
});

const CommentSchema = Schema.Struct({
  id: Schema.Finite,
  body: Schema.NullOr(Schema.String),
  user: Schema.Struct({ login: Schema.String }),
  created_at: Schema.String,
  author_association: Schema.optional(Schema.String),
});

const toRawComment = (comment: typeof CommentSchema.Type) =>
  comment.body
    ? [
        {
          id: comment.id,
          authorLogin: comment.user.login,
          authorAssociation: comment.author_association ?? "NONE",
          body: comment.body,
          createdAtMillis: commentMillis(comment.created_at),
        },
      ]
    : [];

const CheckRunSchema = Schema.Struct({
  name: Schema.String,
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  started_at: Schema.NullOr(Schema.String),
});

const CheckRunsSchema = Schema.Struct({ check_runs: Schema.Array(CheckRunSchema) });

const GraphQlResponse = Schema.Struct({
  data: Schema.optional(Schema.Unknown),
  errors: Schema.optional(Schema.NullOr(Schema.Array(Schema.Struct({ message: Schema.String })))),
});
export type GraphQlPayload = typeof GraphQlResponse.Type;
const decodeGraphQl = Schema.decodeUnknownEffect(GraphQlResponse);

const ClosingReferencesPayload = Schema.Struct({
  repository: Schema.NullOr(
    Schema.Struct({
      pullRequests: Schema.Struct({
        pageInfo: Schema.Struct({
          hasNextPage: Schema.Boolean,
          endCursor: Schema.NullOr(Schema.String),
        }),
        nodes: Schema.Array(
          Schema.NullOr(
            Schema.Struct({
              number: Schema.Finite,
              closingIssuesReferences: Schema.Struct({
                nodes: Schema.Array(
                  Schema.NullOr(
                    Schema.Struct({
                      number: Schema.Finite,
                      repository: Schema.NullOr(Schema.Struct({ nameWithOwner: Schema.String })),
                    }),
                  ),
                ),
              }),
            }),
          ),
        ),
      }),
    }),
  ),
});
const decodeClosingReferences = Schema.decodeUnknownEffect(ClosingReferencesPayload);

export const closingReferencesQuery = `
query ClosingReferences($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 100, after: $cursor, states: OPEN) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        number
        closingIssuesReferences(first: 100) {
          nodes { number repository { nameWithOwner } }
        }
      }
    }
  }
}`;

const sameRepository = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

export const closingReferencesFor = (repo: GitHubRepoRef, payload: typeof ClosingReferencesPayload.Type) => {
  const nameWithOwner = `${repo.owner}/${repo.name}`;
  return new Map(
    (payload.repository?.pullRequests.nodes ?? []).flatMap((pull) => {
      if (!pull) return [];
      const references = pull.closingIssuesReferences.nodes.flatMap((issue) => {
        if (!issue?.repository || !sameRepository(issue.repository.nameWithOwner, nameWithOwner)) return [];
        return [issue.number];
      });
      return [[pull.number, references] as const];
    }),
  );
};

const closingReferencesCursor = (payload: typeof ClosingReferencesPayload.Type) => {
  const page = payload.repository?.pullRequests.pageInfo;
  return page?.hasNextPage ? page.endCursor : null;
};

export const graphQlData = (
  decoded: GraphQlPayload,
): { readonly ok: true; readonly data: unknown } | { readonly ok: false; readonly message: string } => {
  if (decoded.data != null) return { ok: true, data: decoded.data };
  return {
    ok: false,
    message:
      decoded.errors && decoded.errors.length > 0
        ? `GitHub GraphQL error: ${decoded.errors.map((error) => error.message).join("; ")}`
        : "GitHub GraphQL returned no data",
  };
};

const decodeIssues = Schema.decodeUnknownEffect(Schema.Array(IssueSchema));
const decodeCreatedIssue = Schema.decodeUnknownEffect(CreatedIssueSchema);
const decodeCreatedPull = Schema.decodeUnknownEffect(CreatedPullSchema);
const decodeCreatedPulls = Schema.decodeUnknownEffect(Schema.Array(CreatedPullSchema));
const decodePulls = Schema.decodeUnknownEffect(Schema.Array(PullSchema));
const decodePullDetail = Schema.decodeUnknownEffect(PullDetailSchema);
const decodeReviews = Schema.decodeUnknownEffect(Schema.Array(ReviewSchema));
const decodeComments = Schema.decodeUnknownEffect(Schema.Array(CommentSchema));

const commentMillis = (iso: string) =>
  DateTime.make(iso).pipe(
    Option.map(DateTime.toEpochMillis),
    Option.getOrElse(() => 0),
  );
const decodeCheckRuns = Schema.decodeUnknownEffect(CheckRunsSchema);

const millisFromIso = (value: string | null) => {
  const parsed = value === null ? Number.NaN : Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
};

const unavailable = (message: string) => new IssueTrackerError({ reason: "unavailable", message });
const toUnavailable = (error: { readonly message: string }) => unavailable(error.message);

const toRawIssue = (repo: GitHubRepoRef, issue: typeof IssueSchema.Type): RawIssue => ({
  number: issue.number,
  title: issue.title,
  url: issue.html_url || `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
  labels: issue.labels.map(labelName),
  assignees: (issue.assignees ?? []).map((assignee) => assignee.login),
  isPullRequest: issue.pull_request !== undefined,
  openBlockers: issue.issue_dependencies_summary?.blocked_by ?? 0,
});

const openedPull = (created: typeof CreatedPullSchema.Type) =>
  ({ number: created.number, url: created.html_url }) satisfies OpenedPullRequest;

export const parseIssues = Effect.fn("github.parseIssues")(function* (repo: GitHubRepoRef, json: unknown) {
  const issues = yield* Effect.mapError(decodeIssues(json), toUnavailable);
  return issues.map((issue) => toRawIssue(repo, issue));
});

const isoMillis = (millis: number) =>
  Option.match(DateTime.make(millis), { onNone: () => String(millis), onSome: DateTime.formatIso });

const rateLimited = (resumeAtMillis: number) =>
  new IssueTrackerError({
    reason: "rate-limited",
    message: `GitHub rate limit exceeded; resuming after ${isoMillis(resumeAtMillis)}`,
  });

const headerSeconds = (value: string | undefined) => {
  const parsed = value === undefined ? Number.NaN : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const rateLimitResumeAt = (headers: Headers.Headers, nowMillis: number) => {
  const retryAfter = headerSeconds(headers["retry-after"]);
  if (retryAfter !== null) return nowMillis + retryAfter * 1000;
  const reset = headerSeconds(headers["x-ratelimit-reset"]);
  return reset === null ? null : reset * 1000;
};

const isTransientStatus = (status: number) => status === 408 || status === 425 || status >= 500;

class GitHubAttemptError extends Data.TaggedError("GitHubAttemptError")<{
  readonly error: IssueTrackerError;
  readonly transient: boolean;
}> {}

const transientAttemptError = (message: string) =>
  new GitHubAttemptError({ error: unavailable(message), transient: true });

const permanentAttemptError = (error: IssueTrackerError) =>
  new GitHubAttemptError({ error, transient: false });

const transientBackoff = Schedule.exponential("500 millis", 2).pipe(Schedule.jittered);
const transientAttemptDeadline = "30 seconds";
const paginationDeadline = "5 minutes";
const pageSize = 100;

const withTransientRetry = <A, R>(attempt: Effect.Effect<A, GitHubAttemptError, R>) =>
  attempt.pipe(
    Effect.retry({ while: (error) => error.transient, schedule: transientBackoff, times: 3 }),
    Effect.mapError((error) => error.error),
  );

const withPaginationDeadline = <A, R>(operation: Effect.Effect<A, IssueTrackerError, R>) =>
  operation.pipe(
    Effect.timeout(paginationDeadline),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(unavailable(`GitHub pagination timed out after ${paginationDeadline}`)),
    ),
  );

interface EtagEntry {
  readonly etag: string;
  readonly body: unknown;
}

const bodyWithEtag = (body: unknown, etag: string | undefined) => ({ body, etag });

type ConsumeResponse<A> = (
  response: HttpClientResponse.HttpClientResponse,
) => Effect.Effect<A, HttpClientError.HttpClientError>;

const acceptResponse = () => Effect.void;

const repoPath = (repo: GitHubRepoRef, suffix: string) =>
  `https://api.github.com/repos/${repo.owner}/${repo.name}${suffix}`;

const standingStates = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);

export const reviewDecisionOf = (
  states: ReadonlyArray<{ readonly login: string; readonly state: string }>,
): ReviewDecision => {
  const latest = states.reduce(
    (acc, review) => (standingStates.has(review.state) ? acc.set(review.login, review.state) : acc),
    new Map<string, string>(),
  );
  const decisions = [...latest.values()];
  if (decisions.includes("CHANGES_REQUESTED")) return "changes-requested";
  if (decisions.includes("APPROVED")) return "approved";
  return "none";
};

const make = Effect.fn("github.client.make")(function* (client: HttpClient.HttpClient) {
  const credentialStore = Option.getOrNull(yield* Effect.serviceOption(CredentialStore));
  const etags = yield* Ref.make(new Map<string, EtagEntry>());
  const resumeAtRef = yield* Ref.make<number | null>(null);

  const execute = Effect.fn("github.execute")(function* <A>(
    request: HttpClientRequest.HttpClientRequest,
    token: Redacted.Redacted<string>,
    consume: ConsumeResponse<A>,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const cooldownUntil = yield* Ref.get(resumeAtRef);
    if (cooldownUntil !== null && now < cooldownUntil) {
      return yield* permanentAttemptError(rateLimited(cooldownUntil));
    }
    return yield* Effect.gen(function* () {
      const response = yield* client.execute(
        request.pipe(HttpClientRequest.bearerToken(token), HttpClientRequest.setHeaders(baseHeaders)),
      );
      const remaining = response.headers["x-ratelimit-remaining"];
      const resumeAt = rateLimitResumeAt(response.headers, now);
      if (remaining === "0" && resumeAt !== null) {
        yield* Ref.set(resumeAtRef, resumeAt);
      }
      if (response.status === 401) {
        return yield* permanentAttemptError(
          new IssueTrackerError({
            reason: "auth",
            message: "GitHub authentication failed (401)",
          }),
        );
      }
      const throttled =
        response.status === 429 ||
        (response.status === 403 && (remaining === "0" || response.headers["retry-after"] !== undefined));
      if (throttled) {
        const until = resumeAt ?? now + Duration.toMillis(defaultTrackerCooldown);
        yield* Ref.set(resumeAtRef, until);
        return yield* permanentAttemptError(rateLimited(until));
      }
      if (isTransientStatus(response.status)) {
        return yield* transientAttemptError(`GitHub request failed (${response.status})`);
      }
      if (response.status >= 400) {
        return yield* permanentAttemptError(unavailable(`GitHub request failed (${response.status})`));
      }
      return yield* consume(response);
    }).pipe(
      Effect.catchTag("HttpClientError", (error) => Effect.fail(transientAttemptError(error.message))),
      Effect.timeout(transientAttemptDeadline),
      Effect.catchTag("TimeoutError", () =>
        Effect.fail(transientAttemptError(`GitHub request timed out after ${transientAttemptDeadline}`)),
      ),
    );
  });

  const send = Effect.fn("github.send")(function* <A>(
    repo: GitHubRepoRef,
    request: HttpClientRequest.HttpClientRequest,
    consume: ConsumeResponse<A>,
  ) {
    if (repo.connectionId && credentialStore) {
      const account = connectionAccountOf(repo.connectionId);
      const credential = yield* credentialStore
        .bearerToken({
          connectionId: repo.connectionId,
          key: repo.connectionId,
          issueTracker: "github",
          organization: account === "default" ? null : account,
          tokenEnv: repo.tokenEnv,
          clientCredentials: null,
          oauthClientId: null,
        })
        .pipe(
          Effect.mapError((error) =>
            permanentAttemptError(new IssueTrackerError({ reason: "auth", message: error.message })),
          ),
        );
      return yield* execute(request, credential.token, consume);
    }
    const token = yield* Effect.mapError(Config.redacted(repo.tokenEnv), () =>
      permanentAttemptError(
        new IssueTrackerError({ reason: "auth", message: `missing GitHub token in ${repo.tokenEnv}` }),
      ),
    );
    return yield* execute(request, token, consume);
  });

  const fetchJson = Effect.fn("github.fetchJson")(function* (repo: GitHubRepoRef, path: string) {
    const cached = (yield* Ref.get(etags)).get(path);
    const base = HttpClientRequest.get(path);
    const request = cached ? HttpClientRequest.setHeader(base, "if-none-match", cached.etag) : base;
    const { body, etag } = yield* withTransientRetry(
      send(repo, request, (response) => {
        if (response.status === 304 && cached) {
          return Effect.succeed(bodyWithEtag(cached.body, undefined));
        }
        return Effect.map(response.json, (body) => bodyWithEtag(body, response.headers.etag));
      }),
    );
    if (etag !== undefined) {
      yield* Ref.update(etags, (entries) => new Map(entries).set(path, { etag, body }));
    }
    return body;
  });

  const listReviews = Effect.fn("github.listReviews")(function* (repo: GitHubRepoRef, pullNumber: number) {
    const json = yield* fetchJson(repo, repoPath(repo, `/pulls/${pullNumber}/reviews?per_page=100`));
    const reviews = yield* Effect.mapError(decodeReviews(json), toUnavailable);
    return reviews.map(
      (review): RawReview => ({
        authorLogin: review.user.login,
        authorAssociation: review.author_association ?? "NONE",
        state: review.state,
        body: review.body ?? "",
        submittedAtMillis: review.submitted_at ? commentMillis(review.submitted_at) : 0,
      }),
    );
  });

  const listReviewComments = Effect.fn("github.listReviewComments")(function* (
    repo: GitHubRepoRef,
    pullNumber: number,
  ) {
    const json = yield* fetchJson(repo, repoPath(repo, `/pulls/${pullNumber}/comments?per_page=100`));
    const comments = yield* Effect.mapError(decodeComments(json), toUnavailable);
    return comments.flatMap(toRawComment);
  });

  const sendJson = Effect.fn("github.sendJson")(function* (
    repo: GitHubRepoRef,
    request: HttpClientRequest.HttpClientRequest,
    body: unknown,
  ) {
    const withBody = yield* Effect.mapError(HttpClientRequest.bodyJson(request, body), toUnavailable);
    yield* withTransientRetry(send(repo, withBody, acceptResponse));
  });

  const sendAcceptedJsonOnce = Effect.fn("github.sendAcceptedJsonOnce")(function* (
    repo: GitHubRepoRef,
    request: HttpClientRequest.HttpClientRequest,
    body: unknown,
  ) {
    const withBody = yield* Effect.mapError(HttpClientRequest.bodyJson(request, body), toUnavailable);
    const response = yield* send(repo, withBody, Effect.succeed).pipe(
      Effect.mapError((error) => error.error),
    );
    return yield* response.json.pipe(
      Effect.option,
      Effect.timeoutOption(transientAttemptDeadline),
      Effect.map(Option.flatten),
    );
  });

  const addLabel = Effect.fn("github.addLabel")((repo: GitHubRepoRef, issueNumber: number, label: string) =>
    sendJson(repo, HttpClientRequest.post(repoPath(repo, `/issues/${issueNumber}/labels`)), {
      labels: [label],
    }),
  );

  const createIssue = Effect.fn("github.createIssue")(function* (
    repo: GitHubRepoRef,
    input: CreateIssueInput,
  ) {
    const acceptedBody = yield* sendAcceptedJsonOnce(
      repo,
      HttpClientRequest.post(repoPath(repo, "/issues")),
      {
        title: input.title,
        body: input.body,
        labels: input.labels,
      },
    );
    if (Option.isNone(acceptedBody)) return;
    const created = yield* Effect.mapError(decodeCreatedIssue(acceptedBody.value), toUnavailable);
    const applied = new Set(created.labels.map(labelName));
    yield* Effect.forEach(
      input.labels.filter((label) => !applied.has(label)),
      (label) => addLabel(repo, created.number, label),
    );
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

  // Projects v2 can return partial data alongside per-item errors; only fail when there is nothing to decode.
  const graphql = Effect.fn("github.graphql")(function* (
    repo: GitHubRepoRef,
    query: string,
    variables: Record<string, unknown>,
  ) {
    const request = HttpClientRequest.post("https://api.github.com/graphql");
    const withBody = yield* Effect.mapError(
      HttpClientRequest.bodyJson(request, { query, variables }),
      toUnavailable,
    );
    const json = yield* withTransientRetry(send(repo, withBody, (response) => response.json));
    const decoded = yield* Effect.mapError(decodeGraphQl(json), toUnavailable);
    const result = graphQlData(decoded);
    if (!result.ok) return yield* unavailable(result.message);
    return result.data;
  });

  const collectPriorityPages: (
    repo: GitHubRepoRef,
    source: GitHubPrioritySource,
    field: string,
    cursor?: string | null,
  ) => Effect.Effect<ReadonlyMap<number, Priority>, IssueTrackerError> = Effect.fn(
    "github.projectPriorityPage",
  )(function* (repo, source, field, cursor = null) {
    const data = yield* graphql(repo, priorityQuery, {
      owner: repo.owner,
      number: source.project,
      field,
      cursor,
    });
    const payload = yield* Effect.mapError(decodeProjectPriorities(data), toUnavailable);
    if (cursor === null && boardMissing(payload)) {
      return yield* unavailable(`GitHub project ${source.project} not found for ${repo.owner}`);
    }
    const page = pageOf(payload, repo);
    const current = new Map(page.entries);
    if (page.nextCursor === null) return current;
    const remaining = yield* collectPriorityPages(repo, source, field, page.nextCursor);
    return new Map([...current, ...remaining]);
  });

  // One paged query so cost tracks board size, not backlog size.
  const collectPriorities = Effect.fn("github.projectPriorities")(function* (
    repo: GitHubRepoRef,
    source: GitHubPrioritySource,
  ) {
    return yield* withPaginationDeadline(
      collectPriorityPages(repo, source, source.field ?? defaultPriorityField),
    );
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

  const collectIssuePages: (
    repo: GitHubRepoRef,
    page?: number,
  ) => Effect.Effect<ReadonlyArray<RawIssue>, IssueTrackerError> = Effect.fn("github.collectIssuePages")(
    function* (repo, page = 1) {
      const json = yield* fetchJson(
        repo,
        repoPath(repo, `/issues?state=open&per_page=${pageSize}&page=${page}`),
      );
      const current = yield* parseIssues(repo, json);
      if (current.length < pageSize) return current;
      const remaining = yield* collectIssuePages(repo, page + 1);
      return [...current, ...remaining];
    },
  );

  return {
    listIssues: Effect.fn("github.listIssues")(function* (repo: GitHubRepoRef) {
      return yield* withPaginationDeadline(collectIssuePages(repo));
    }),
    listPulls: Effect.fn("github.listPulls")(function* (repo: GitHubRepoRef) {
      const json = yield* fetchJson(
        repo,
        repoPath(repo, "/pulls?state=open&per_page=100&sort=updated&direction=desc"),
      );
      const references = yield* pullClosingReferences(repo);
      const pulls = yield* Effect.mapError(decodePulls(json), toUnavailable);
      return pulls.map(
        (pull): RawPull => ({
          number: pull.number,
          url: pull.html_url || `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
          authorLogin: pull.user.login,
          authorAssociation: pull.author_association ?? "NONE",
          draft: pull.draft ?? false,
          headSha: pull.head.sha,
          headRef: pull.head.ref,
          headRepository: pull.head.repo?.full_name ?? null,
          closingIssueNumbers: references.get(pull.number) ?? [],
          updatedAtMillis: millisFromIso(pull.updated_at ?? null),
        }),
      );
    }),
    pullMergeableState: (repo: GitHubRepoRef, pullNumber: number) =>
      Effect.gen(function* () {
        const json = yield* fetchJson(repo, repoPath(repo, `/pulls/${pullNumber}`));
        const detail = yield* Effect.mapError(decodePullDetail(json), toUnavailable);
        return detail.mergeable_state ?? null;
      }),
    listComments: Effect.fn("github.listComments")(function* (repo: GitHubRepoRef, issueNumber: number) {
      const json = yield* fetchJson(repo, repoPath(repo, `/issues/${issueNumber}/comments?per_page=100`));
      const comments = yield* Effect.mapError(decodeComments(json), toUnavailable);
      return comments.flatMap(toRawComment);
    }),
    listReviewComments,
    listReviews,
    projectPriorities: collectPriorities,
    listCheckRuns: (repo: GitHubRepoRef, sha: string) =>
      Effect.gen(function* () {
        const json = yield* fetchJson(repo, repoPath(repo, `/commits/${sha}/check-runs?per_page=100`));
        const decoded = yield* Effect.mapError(decodeCheckRuns(json), toUnavailable);
        return decoded.check_runs.map(
          (run): CheckRun => ({
            name: run.name,
            status: run.status,
            conclusion: run.conclusion,
            startedAtMillis: millisFromIso(run.started_at),
          }),
        );
      }),
    createIssue,
    createPull,
    addLabel,
    removeLabel: (repo: GitHubRepoRef, issueNumber: number, label: string) =>
      withTransientRetry(
        send(
          repo,
          HttpClientRequest.delete(
            repoPath(repo, `/issues/${issueNumber}/labels/${encodeURIComponent(label)}`),
          ),
          acceptResponse,
        ),
      ),
    createComment: (repo: GitHubRepoRef, issueNumber: number, body: string) =>
      sendJson(repo, HttpClientRequest.post(repoPath(repo, `/issues/${issueNumber}/comments`)), { body }),
    editComment: (repo: GitHubRepoRef, commentId: number, body: string) =>
      sendJson(repo, HttpClientRequest.patch(repoPath(repo, `/issues/comments/${commentId}`)), { body }),
    verifyCredential: (token: Redacted.Redacted<string>) =>
      execute(HttpClientRequest.get("https://api.github.com/user"), token, acceptResponse).pipe(
        Effect.mapError((error) => error.error),
      ),
  };
});

export type GitHubClientService = Effect.Success<ReturnType<typeof make>>;

export class GitHubClient extends Context.Service<GitHubClient, GitHubClientService>()(
  "@cogwork/engine/github/client/GitHubClient",
) {}

export const layer = Layer.effect(GitHubClient, Effect.flatMap(HttpClient.HttpClient, make));
