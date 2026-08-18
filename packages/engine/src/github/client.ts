import type { GitHubPrioritySource, Priority } from "@cogwork/contracts";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Headers from "effect/unstable/http/Headers";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type { CheckRun } from "../ci";
import { IssueTrackerError } from "../issue-tracker";
import { decodeProjectPriorities, defaultPriorityField, pageOf, priorityQuery } from "./priority";

export interface GitHubRepoRef {
  readonly owner: string;
  readonly name: string;
  readonly tokenEnv: string;
}

export type ReviewDecision = "changes-requested" | "approved" | "none";

export interface RawIssue {
  readonly number: number;
  readonly title: string;
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
  labels: Schema.Array(LabelName),
  assignees: Schema.optional(Schema.Array(Schema.Struct({ login: Schema.String }))),
  pull_request: Schema.optional(Schema.Unknown),
  issue_dependencies_summary: Schema.optional(Schema.NullOr(DependenciesSummarySchema)),
});

const PullSchema = Schema.Struct({
  number: Schema.Finite,
  html_url: Schema.optional(Schema.NullOr(Schema.String)),
  user: Schema.Struct({ login: Schema.String }),
  draft: Schema.optional(Schema.Boolean),
  head: Schema.Struct({ sha: Schema.String, ref: Schema.String }),
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
const decodeGraphQl = Schema.decodeUnknownEffect(GraphQlResponse);

const decodeIssues = Schema.decodeUnknownEffect(Schema.Array(IssueSchema));
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

const toRawIssue = (issue: typeof IssueSchema.Type): RawIssue => ({
  number: issue.number,
  title: issue.title,
  labels: issue.labels.map(labelName),
  assignees: (issue.assignees ?? []).map((assignee) => assignee.login),
  isPullRequest: issue.pull_request !== undefined,
  openBlockers: issue.issue_dependencies_summary?.blocked_by ?? 0,
});

export const parseIssues = Effect.fn("github.parseIssues")(function* (json: unknown) {
  const issues = yield* Effect.mapError(decodeIssues(json), toUnavailable);
  return issues.map(toRawIssue);
});

const defaultCooldownMillis = 60_000;

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

const isTransient = (error: IssueTrackerError) => error.reason === "unavailable";
const transientBackoff = Schedule.exponential("500 millis", 2).pipe(Schedule.jittered);

interface EtagEntry {
  readonly etag: string;
  readonly body: unknown;
}

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
  const etags = yield* Ref.make(new Map<string, EtagEntry>());
  const resumeAtRef = yield* Ref.make<number | null>(null);

  const execute = Effect.fn("github.execute")(function* (
    request: HttpClientRequest.HttpClientRequest,
    token: Redacted.Redacted<string>,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const cooldownUntil = yield* Ref.get(resumeAtRef);
    if (cooldownUntil !== null && now < cooldownUntil) {
      return yield* rateLimited(cooldownUntil);
    }
    const response = yield* Effect.catchTag(
      client.execute(
        request.pipe(HttpClientRequest.bearerToken(token), HttpClientRequest.setHeaders(baseHeaders)),
      ),
      "HttpClientError",
      (error) => Effect.fail(unavailable(error.message)),
    );
    const remaining = response.headers["x-ratelimit-remaining"];
    const resumeAt = rateLimitResumeAt(response.headers, now);
    if (remaining === "0" && resumeAt !== null) {
      yield* Ref.set(resumeAtRef, resumeAt);
    }
    if (response.status === 401) {
      return yield* new IssueTrackerError({ reason: "auth", message: "GitHub authentication failed (401)" });
    }
    const throttled =
      response.status === 429 ||
      (response.status === 403 && (remaining === "0" || response.headers["retry-after"] !== undefined));
    if (throttled) {
      const until = resumeAt ?? now + defaultCooldownMillis;
      yield* Ref.set(resumeAtRef, until);
      return yield* rateLimited(until);
    }
    if (response.status >= 400) {
      return yield* unavailable(`GitHub request failed (${response.status})`);
    }
    return response;
  });

  const send = Effect.fn("github.send")(function* (
    repo: GitHubRepoRef,
    request: HttpClientRequest.HttpClientRequest,
  ) {
    const token = yield* Effect.mapError(
      Config.redacted(repo.tokenEnv),
      () => new IssueTrackerError({ reason: "auth", message: `missing GitHub token in ${repo.tokenEnv}` }),
    );
    return yield* execute(request, token);
  });

  const fetchJson = Effect.fn("github.fetchJson")(function* (repo: GitHubRepoRef, path: string) {
    const cached = (yield* Ref.get(etags)).get(path);
    const base = HttpClientRequest.get(path);
    const request = cached ? HttpClientRequest.setHeader(base, "if-none-match", cached.etag) : base;
    const response = yield* Effect.retry(send(repo, request), {
      while: isTransient,
      schedule: transientBackoff,
      times: 3,
    });
    if (response.status === 304 && cached) {
      return cached.body;
    }
    const body = yield* Effect.mapError(response.json, toUnavailable);
    const etag = response.headers.etag;
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
    yield* send(repo, withBody);
  });

  // The one GraphQL read path in an otherwise REST-only adapter, added for the Projects v2 priority
  // field the REST API cannot reach. A `200` carrying an `errors` array (e.g. a missing scope) is a
  // failure just like a `4xx`.
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
    const response = yield* Effect.retry(send(repo, withBody), {
      while: isTransient,
      schedule: transientBackoff,
      times: 3,
    });
    const json = yield* Effect.mapError(response.json, toUnavailable);
    const decoded = yield* Effect.mapError(decodeGraphQl(json), toUnavailable);
    if (decoded.errors && decoded.errors.length > 0) {
      return yield* unavailable(
        `GitHub GraphQL error: ${decoded.errors.map((error) => error.message).join("; ")}`,
      );
    }
    return decoded.data;
  });

  // Page through a Projects v2 board and collect issue-number → priority. One paged GraphQL query,
  // not one per issue, so the cost tracks board size rather than backlog size.
  const collectPriorities = Effect.fn("github.projectPriorities")(function* (
    repo: GitHubRepoRef,
    source: GitHubPrioritySource,
  ) {
    const field = source.field ?? defaultPriorityField;
    const byNumber = new Map<number, Priority>();
    let cursor: string | null = null;
    do {
      const data = yield* graphql(repo, priorityQuery, {
        owner: repo.owner,
        number: source.project,
        field,
        cursor,
      });
      const payload = yield* Effect.mapError(decodeProjectPriorities(data), toUnavailable);
      const page = pageOf(payload);
      for (const [number, priority] of page.entries) byNumber.set(number, priority);
      cursor = page.nextCursor;
    } while (cursor !== null);
    const result: ReadonlyMap<number, Priority> = byNumber;
    return result;
  });

  return {
    listIssues: Effect.fn("github.listIssues")(function* (repo: GitHubRepoRef) {
      const json = yield* fetchJson(repo, repoPath(repo, "/issues?state=open&per_page=100"));
      return yield* parseIssues(json);
    }),
    listPulls: Effect.fn("github.listPulls")(function* (repo: GitHubRepoRef) {
      const json = yield* fetchJson(repo, repoPath(repo, "/pulls?state=open&per_page=100"));
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
    addLabel: (repo: GitHubRepoRef, issueNumber: number, label: string) =>
      sendJson(repo, HttpClientRequest.post(repoPath(repo, `/issues/${issueNumber}/labels`)), {
        labels: [label],
      }),
    removeLabel: (repo: GitHubRepoRef, issueNumber: number, label: string) =>
      Effect.asVoid(
        send(
          repo,
          HttpClientRequest.delete(
            repoPath(repo, `/issues/${issueNumber}/labels/${encodeURIComponent(label)}`),
          ),
        ),
      ),
    createComment: (repo: GitHubRepoRef, issueNumber: number, body: string) =>
      sendJson(repo, HttpClientRequest.post(repoPath(repo, `/issues/${issueNumber}/comments`)), { body }),
    editComment: (repo: GitHubRepoRef, commentId: number, body: string) =>
      sendJson(repo, HttpClientRequest.patch(repoPath(repo, `/issues/comments/${commentId}`)), { body }),
  };
});

export type GitHubClientService = Effect.Success<ReturnType<typeof make>>;

export class GitHubClient extends Context.Service<GitHubClient, GitHubClientService>()(
  "@cogwork/engine/github/client/GitHubClient",
) {}

export const layer = Layer.effect(GitHubClient, Effect.flatMap(HttpClient.HttpClient, make));
