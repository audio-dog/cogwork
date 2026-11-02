import {
  type ConnectionId,
  connectionAccountOf,
  GitHubIssueFieldId,
  type GitHubPriorityField,
  TrimmedNonEmptyString,
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
import { defaultTrackerCooldown, IssueTrackerError } from "../issue-tracker";
import type { OpenedPullRequest, OpenPullRequestInput } from "../source-control";

export interface GitHubRepoRef {
  readonly owner: string;
  readonly name: string;
  readonly tokenEnv: string;
  readonly connectionId?: ConnectionId;
}

export interface GitHubIssueCreateInput {
  readonly title: string;
  readonly body: string;
  readonly labels: ReadonlyArray<string>;
}

export const repoRefFromRepository = (repository: string) => {
  const [owner, name, extra] = repository.split("/");
  if (!owner || !name || extra) return null;
  return { owner, name, tokenEnv: "GITHUB_TOKEN" };
};

export type ReviewDecision = "changes-requested" | "approved" | "none";

export interface RawIssue {
  readonly nodeId: string;
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly labels: ReadonlyArray<string>;
  readonly assignees: ReadonlyArray<string>;
  readonly isPullRequest: boolean;
  readonly openBlockers: number;
  readonly body: string;
  readonly state: "open" | "closed";
  readonly createdAtMillis: number;
  readonly updatedAtMillis?: number;
  readonly authorLogin?: string;
}

export interface RawIssueEvent {
  readonly id: number;
  readonly event: string;
  readonly labelName: string | null;
  readonly createdAtMillis: number;
}

export interface RawIssuePullReference {
  readonly body: string;
  readonly merged: boolean;
  readonly repository: string;
}

export interface RawPull {
  readonly number: number;
  readonly url: string;
  readonly authorLogin: string;
  readonly authorAssociation: string;
  readonly draft: boolean;
  readonly headSha: string;
  readonly baseSha?: string;
  readonly baseRef?: string;
  readonly headRef: string;
  readonly headRepository: string | null;
  readonly closingIssueNumbers: ReadonlyArray<number>;
  readonly updatedAtMillis: number;
}

export interface RawPullDetail extends RawPull {
  readonly title: string;
  readonly body: string;
}

export interface RawPullFile {
  readonly path: string;
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
  readonly patch: string | null;
}

export interface CreateReviewInput {
  readonly commitId: string;
  readonly body: string;
  readonly comments: ReadonlyArray<{ readonly path: string; readonly line: number; readonly body: string }>;
  readonly event: "APPROVE" | "COMMENT" | "REQUEST_CHANGES" | null;
}

interface RawCommentFields {
  readonly id: number;
  readonly authorLogin: string;
  readonly authorAssociation: string;
  readonly authorType?: string;
  readonly body: string;
  readonly createdAtMillis: number;
}

export type RawIssueComment = Omit<RawCommentFields, "authorLogin"> & {
  readonly authorLogin: string | null;
};

export type RawReviewComment = RawCommentFields & {
  readonly inReplyToId: number | null;
  readonly subjectType: "line" | "file";
  readonly path?: string | null;
  readonly line?: number | null;
};

export interface RawReview {
  readonly id: number;
  readonly authorLogin: string;
  readonly authorAssociation: string;
  readonly authorType?: string;
  readonly state: string;
  readonly body: string;
  readonly submittedAtMillis: number;
}

const baseHeaders = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2026-03-10",
  "User-Agent": "cogwork",
};

const LabelName = Schema.Union([Schema.String, Schema.Struct({ name: Schema.String })]);
const labelName = (label: typeof LabelName.Type) => (typeof label === "string" ? label : label.name);

// GitHub reports `blocked_by` as open blockers only; `total_blocked_by` counts closed ones too.
const DependenciesSummarySchema = Schema.Struct({
  blocked_by: Schema.optional(Schema.NullOr(Schema.Natural)),
});

const IssueSchema = Schema.Struct({
  node_id: Schema.String,
  number: Schema.Finite,
  title: Schema.String,
  html_url: Schema.optional(Schema.NullOr(Schema.String)),
  labels: Schema.Array(LabelName),
  assignees: Schema.optional(Schema.Array(Schema.Struct({ login: Schema.String }))),
  pull_request: Schema.optional(Schema.Unknown),
  issue_dependencies_summary: Schema.optional(Schema.NullOr(DependenciesSummarySchema)),
  body: Schema.NullOr(Schema.String),
  state: Schema.Union([Schema.Literal("open"), Schema.Literal("closed")]),
  created_at: Schema.String,
  updated_at: Schema.optional(Schema.String),
  user: Schema.optional(Schema.NullOr(Schema.Struct({ login: Schema.String }))),
});

const GitHubIssueFieldSchema = Schema.Struct({
  id: GitHubIssueFieldId,
  name: TrimmedNonEmptyString,
  data_type: Schema.String,
});

const SearchIssuesSchema = Schema.Struct({ items: Schema.Array(IssueSchema) });

const CreatedPullSchema = Schema.Struct({
  number: Schema.Finite,
  html_url: Schema.String,
});

const AuthenticatedUserSchema = Schema.Struct({ login: TrimmedNonEmptyString });

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
  base: Schema.optional(Schema.Struct({ sha: Schema.String, ref: Schema.optional(Schema.String) })),
  author_association: Schema.optional(Schema.String),
  updated_at: Schema.optional(Schema.NullOr(Schema.String)),
});

const PullDetailSchema = Schema.Struct({
  ...PullSchema.fields,
  title: Schema.String,
  body: Schema.NullOr(Schema.String),
  mergeable_state: Schema.optional(Schema.NullOr(Schema.String)),
});
const PullMergeableStateSchema = Schema.Struct({
  mergeable_state: Schema.optional(Schema.NullOr(Schema.String)),
});

const PullFileSchema = Schema.Struct({
  filename: Schema.String,
  status: Schema.String,
  additions: Schema.Natural,
  deletions: Schema.Natural,
  changes: Schema.Natural,
  patch: Schema.optional(Schema.NullOr(Schema.String)),
});

const GitHubUserSchema = Schema.Struct({ login: Schema.String, type: Schema.optional(Schema.String) });
const GitHubCollaboratorsSchema = Schema.Array(GitHubUserSchema);
const RequestedReviewersSchema = Schema.Struct({ users: Schema.Array(GitHubUserSchema) });

const ReviewSchema = Schema.Struct({
  id: Schema.Finite,
  state: Schema.String,
  user: Schema.NullOr(GitHubUserSchema),
  body: Schema.NullOr(Schema.String),
  author_association: Schema.optional(Schema.String),
  submitted_at: Schema.optional(Schema.NullOr(Schema.String)),
});

const IssueEventSchema = Schema.Struct({
  id: Schema.Finite,
  event: Schema.String,
  label: Schema.optional(Schema.NullOr(Schema.Struct({ name: Schema.String }))),
  created_at: Schema.String,
});

const CommentFields = {
  id: Schema.Finite,
  body: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  author_association: Schema.optional(Schema.String),
};

const IssueCommentSchema = Schema.Struct({
  ...CommentFields,
  user: Schema.NullOr(GitHubUserSchema),
});

const ReviewCommentSchema = Schema.Struct({
  ...CommentFields,
  user: Schema.NullOr(GitHubUserSchema),
  in_reply_to_id: Schema.NullOr(Schema.Finite).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  subject_type: Schema.Union([Schema.Literal("line"), Schema.Literal("file")]),
  path: Schema.optional(Schema.NullOr(Schema.String)),
  line: Schema.optional(Schema.NullOr(Schema.Finite)),
});

const toRawIssueComment = (comment: typeof IssueCommentSchema.Type) => ({
  id: comment.id,
  authorLogin: comment.user?.login ?? null,
  authorAssociation: comment.author_association ?? "NONE",
  ...(comment.user?.type ? { authorType: comment.user.type } : {}),
  body: comment.body ?? "",
  createdAtMillis: commentMillis(comment.created_at),
});

const toRawReviewComment = ({ user, ...comment }: typeof ReviewCommentSchema.Type) =>
  comment.body && user
    ? [
        {
          id: comment.id,
          authorLogin: user.login,
          authorAssociation: comment.author_association ?? "NONE",
          ...(user.type ? { authorType: user.type } : {}),
          body: comment.body,
          createdAtMillis: commentMillis(comment.created_at),
          inReplyToId: comment.in_reply_to_id,
          subjectType: comment.subject_type,
          path: comment.path ?? null,
          line: comment.line ?? null,
        } satisfies RawReviewComment,
      ]
    : [];

const CheckRunSchema = Schema.Struct({
  name: Schema.String,
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  started_at: Schema.NullOr(Schema.String),
  completed_at: Schema.NullOr(Schema.String),
});

const CheckRunsSchema = Schema.Struct({ check_runs: Schema.Array(CheckRunSchema) });

const GraphQlResponse = Schema.Struct({
  data: Schema.optional(Schema.Unknown),
  errors: Schema.optional(Schema.NullOr(Schema.Array(Schema.Struct({ message: Schema.String })))),
});
export type GraphQlPayload = typeof GraphQlResponse.Type;
const decodeGraphQl = Schema.decodeUnknownEffect(GraphQlResponse);
const decodeGitHubError = Schema.decodeUnknownOption(Schema.Struct({ message: Schema.String }));
const PageInfo = Schema.Struct({
  hasNextPage: Schema.Boolean,
  endCursor: Schema.NullOr(Schema.String),
});

const ClosingReferencesPayload = Schema.Struct({
  repository: Schema.NullOr(
    Schema.Struct({
      pullRequests: Schema.Struct({
        pageInfo: PageInfo,
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

const IssuePullReferencesPayload = Schema.Struct({
  repository: Schema.NullOr(
    Schema.Struct({
      issue: Schema.NullOr(
        Schema.Struct({
          timelineItems: Schema.Struct({
            pageInfo: PageInfo,
            nodes: Schema.Array(
              Schema.NullOr(
                Schema.Struct({
                  source: Schema.Struct({
                    body: Schema.optional(Schema.NullOr(Schema.String)),
                    merged: Schema.optional(Schema.Boolean),
                    repository: Schema.optional(Schema.Struct({ nameWithOwner: Schema.String })),
                  }),
                }),
              ),
            ),
          }),
        }),
      ),
    }),
  ),
});
const decodeIssuePullReferences = Schema.decodeUnknownEffect(IssuePullReferencesPayload);

const GraphQlIssueFieldId = Schema.FiniteFromString.pipe(Schema.decodeTo(GitHubIssueFieldId));
const IssueFieldValueNode = Schema.Struct({
  __typename: Schema.String,
  name: Schema.optionalKey(TrimmedNonEmptyString),
  field: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        fullDatabaseId: Schema.optionalKey(GraphQlIssueFieldId),
      }),
    ),
  ),
});
const IssueFieldValuePageInfo = Schema.Struct({
  hasNextPage: Schema.Boolean,
  endCursor: Schema.NullOr(Schema.String),
});
const IssueFieldValues = Schema.Struct({
  pageInfo: IssueFieldValuePageInfo,
  nodes: Schema.Array(Schema.NullOr(IssueFieldValueNode)),
});
const IssueFieldValueIssue = Schema.Struct({
  id: Schema.String,
  number: Schema.Finite,
  issueFieldValues: IssueFieldValues,
});
const IssueFieldValuesPayload = Schema.Struct({
  nodes: Schema.Array(Schema.NullOr(IssueFieldValueIssue)),
});
const IssueFieldValuePagesPayload = Schema.Record(Schema.String, Schema.NullOr(IssueFieldValueIssue));
const decodeIssueFieldValues = Schema.decodeUnknownEffect(IssueFieldValuesPayload);
const decodeIssueFieldValuePages = Schema.decodeUnknownEffect(IssueFieldValuePagesPayload);

const issueFieldValuePageSelection = (after: string) => `
  id
  number
  issueFieldValues(first: 100${after}) {
    pageInfo { hasNextPage endCursor }
    nodes {
      __typename
      ... on IssueFieldSingleSelectValue {
        name
        field { ... on IssueFieldSingleSelect { fullDatabaseId } }
      }
    }
  }`;

export const issueFieldValuesQuery = `
query IssueFieldValues($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on Issue {
      ${issueFieldValuePageSelection("")}
    }
  }
}`;

const issueFieldValuePagesQuery = (count: number) => {
  const variables = Array.from(
    { length: count },
    (_, index) => `$id${index}: ID!, $cursor${index}: String!`,
  ).join(", ");
  const issues = Array.from(
    { length: count },
    (_, index) => `
  issue${index}: node(id: $id${index}) {
    ... on Issue {
      ${issueFieldValuePageSelection(`, after: $cursor${index}`)}
    }
  }`,
  ).join("");
  return `query IssueFieldValuePages(${variables}) {${issues}\n}`;
};

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

export const issuePullReferencesQuery = `
query IssuePullReferences($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      timelineItems(first: 100, after: $cursor, itemTypes: [CROSS_REFERENCED_EVENT]) {
        pageInfo { hasNextPage endCursor }
        nodes {
          ... on CrossReferencedEvent {
            source {
              ... on PullRequest {
                body
                merged
                repository { nameWithOwner }
              }
            }
          }
        }
      }
    }
  }
}`;

export const issuePullReferencesPage = (payload: typeof IssuePullReferencesPayload.Type) => {
  const timeline = payload.repository?.issue?.timelineItems;
  const references = (timeline?.nodes ?? []).flatMap((event) => {
    const source = event?.source;
    if (source?.body === undefined || source.merged === undefined || source.repository === undefined) {
      return [];
    }
    return [
      {
        body: source.body ?? "",
        merged: source.merged,
        repository: source.repository.nameWithOwner,
      } satisfies RawIssuePullReference,
    ];
  });
  const nextCursor = timeline?.pageInfo.hasNextPage ? timeline.pageInfo.endCursor : null;
  return { references, nextCursor };
};

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
const decodeIssue = Schema.decodeUnknownEffect(IssueSchema);
const decodeSearchIssues = Schema.decodeUnknownEffect(SearchIssuesSchema);
const decodeIssueFields = Schema.decodeUnknownEffect(Schema.Array(GitHubIssueFieldSchema));
const decodeAuthenticatedUser = Schema.decodeUnknownEffect(AuthenticatedUserSchema);
const decodeCreatedPull = Schema.decodeUnknownEffect(CreatedPullSchema);
const decodeCreatedPulls = Schema.decodeUnknownEffect(Schema.Array(CreatedPullSchema));
const decodePulls = Schema.decodeUnknownEffect(Schema.Array(PullSchema));
const decodePullDetail = Schema.decodeUnknownEffect(PullDetailSchema);
const decodePullFiles = Schema.decodeUnknownEffect(Schema.Array(PullFileSchema));
const decodeReviews = Schema.decodeUnknownEffect(Schema.Array(ReviewSchema));
const decodeIssueComments = Schema.decodeUnknownEffect(Schema.Array(IssueCommentSchema));
const decodeReviewComments = Schema.decodeUnknownEffect(Schema.Array(ReviewCommentSchema));

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

const unavailable = (message: string, writeMayHaveCommitted?: boolean) =>
  new IssueTrackerError({
    reason: "unavailable",
    message,
    ...(writeMayHaveCommitted === undefined ? {} : { writeMayHaveCommitted }),
  });
const toUnavailable = (error: { readonly message: string }) => unavailable(error.message);
const toAcceptedWriteError = (error: IssueTrackerError) =>
  new IssueTrackerError({
    reason: error.reason,
    message: error.message,
    writeMayHaveCommitted: true,
    ...(error.retryable === undefined ? {} : { retryable: error.retryable }),
    ...(error.retryAfterMillis === undefined ? {} : { retryAfterMillis: error.retryAfterMillis }),
    ...(error.connectionId === undefined ? {} : { connectionId: error.connectionId }),
  });

const priorityFieldReadError = (repo: GitHubRepoRef, error: IssueTrackerError) =>
  new IssueTrackerError({
    reason: error.reason,
    message: `Could not load GitHub issue fields for ${repo.owner}. Grant read:org or Issue Fields read permission. ${error.message}`,
    ...(error.retryable === undefined ? {} : { retryable: error.retryable }),
    ...(error.retryAfterMillis === undefined ? {} : { retryAfterMillis: error.retryAfterMillis }),
    ...(error.connectionId === undefined ? {} : { connectionId: error.connectionId }),
  });

const issueFieldEntry = (
  value: typeof IssueFieldValueNode.Type,
): readonly [GitHubIssueFieldId, string] | null => {
  if (value.__typename !== "IssueFieldSingleSelectValue" || !value.name) return null;
  const fieldId = value.field?.fullDatabaseId;
  return fieldId ? [fieldId, value.name] : null;
};

const issueFieldValues = (values: ReadonlyArray<typeof IssueFieldValueNode.Type | null>) =>
  new Map(
    values.flatMap((value) => {
      if (!value) return [];
      const entry = issueFieldEntry(value);
      return entry ? [entry] : [];
    }),
  );

interface IssueFieldValueState {
  readonly nodeId: string;
  readonly number: number;
  readonly values: ReadonlyMap<GitHubIssueFieldId, string>;
  readonly cursor: string | null;
}

const issueFieldValueCursor = (pageInfo: typeof IssueFieldValuePageInfo.Type) =>
  pageInfo.hasNextPage ? pageInfo.endCursor : null;

const issueFieldValueState = (
  issue: typeof IssueFieldValueIssue.Type,
  previous: ReadonlyMap<GitHubIssueFieldId, string>,
): IssueFieldValueState => ({
  nodeId: issue.id,
  number: issue.number,
  values: new Map([...previous, ...issueFieldValues(issue.issueFieldValues.nodes)]),
  cursor: issueFieldValueCursor(issue.issueFieldValues.pageInfo),
});

const completedIssueFieldValueState = (state: IssueFieldValueState): IssueFieldValueState => ({
  ...state,
  cursor: null,
});

const continuedIssueFieldValueState = (
  state: IssueFieldValueState,
  issue: typeof IssueFieldValueIssue.Type | null | undefined,
) => {
  if (!issue) return completedIssueFieldValueState(state);
  return issueFieldValueState(issue, state.values);
};

const issueFieldValuePageVariables = (states: ReadonlyArray<IssueFieldValueState>) =>
  Object.fromEntries(
    states.flatMap((state, index) => [
      [`id${index}`, state.nodeId],
      [`cursor${index}`, state.cursor],
    ]),
  );

const issueFieldValuesByIssue = (states: ReadonlyArray<IssueFieldValueState>) =>
  new Map(states.map((state) => [state.number, state.values] as const));

const toRawIssue = (repo: GitHubRepoRef, issue: typeof IssueSchema.Type): RawIssue => ({
  nodeId: issue.node_id,
  number: issue.number,
  title: issue.title,
  url: issue.html_url || `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
  labels: issue.labels.map(labelName),
  assignees: (issue.assignees ?? []).map((assignee) => assignee.login),
  isPullRequest: issue.pull_request !== undefined,
  openBlockers: issue.issue_dependencies_summary?.blocked_by ?? 0,
  body: issue.body ?? "",
  state: issue.state,
  createdAtMillis: millisFromIso(issue.created_at),
  updatedAtMillis: millisFromIso(issue.updated_at ?? issue.created_at),
  ...(issue.user ? { authorLogin: issue.user.login } : {}),
});

const openedPull = (created: typeof CreatedPullSchema.Type) =>
  ({ number: created.number, url: created.html_url }) satisfies OpenedPullRequest;

export const parseIssues = Effect.fn("github.parseIssues")(function* (repo: GitHubRepoRef, json: unknown) {
  const issues = yield* Effect.mapError(decodeIssues(json), toUnavailable);
  return issues.map((issue) => toRawIssue(repo, issue));
});

export const parseIssueComments = Effect.fn("github.parseIssueComments")(function* (json: unknown) {
  const comments = yield* Effect.mapError(decodeIssueComments(json), toUnavailable);
  return comments.map(toRawIssueComment);
});

export const parseReviewComments = Effect.fn("github.parseReviewComments")(function* (json: unknown) {
  const comments = yield* Effect.mapError(decodeReviewComments(json), toUnavailable);
  return comments.flatMap(toRawReviewComment);
});

const isoMillis = (millis: number) =>
  Option.match(DateTime.make(millis), { onNone: () => String(millis), onSome: DateTime.formatIso });

const rateLimited = (resumeAtMillis: number) =>
  new IssueTrackerError({
    reason: "rate-limited",
    message: `GitHub rate limit exceeded; resuming after ${isoMillis(resumeAtMillis)}`,
    writeMayHaveCommitted: false,
  });

const headerSeconds = (value: string | undefined) => {
  const parsed = value === undefined ? Number.NaN : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const rateLimitResumeAt = (headers: Headers.Headers, nowMillis: number) => {
  const retryAfter = headerSeconds(headers["retry-after"]);
  if (retryAfter !== null) return nowMillis + retryAfter * 1000;
  if (headers["x-ratelimit-remaining"] !== "0") return null;
  const reset = headerSeconds(headers["x-ratelimit-reset"]);
  return reset === null ? null : reset * 1000;
};

const isTransientStatus = (status: number) => status === 408 || status === 425 || status >= 500;

const classifyGitHubError = (body: unknown) => {
  const error = Option.getOrNull(decodeGitHubError(body));
  if (!error) return "unknown";
  const message = error.message.toLowerCase();
  if (message.includes("secondary rate limit")) return "rate-limited";
  if (message.includes("resource not accessible")) return "permission";
  return "unknown";
};

const transientAttemptDeadline = "30 seconds";

const classifyForbiddenResponse = Effect.fn("github.classifyForbiddenResponse")(function* (
  response: HttpClientResponse.HttpClientResponse,
  remaining: string | undefined,
) {
  if (remaining === "0" || response.headers["retry-after"] !== undefined) return "rate-limited";
  const body = yield* response.json.pipe(
    Effect.timeoutOption(transientAttemptDeadline),
    Effect.catchTag("HttpClientError", () => Effect.succeed(Option.none())),
  );
  return Option.match(body, { onNone: () => "unknown", onSome: classifyGitHubError });
});

class GitHubAttemptError extends Data.TaggedError("GitHubAttemptError")<{
  readonly error: IssueTrackerError;
  readonly transient: boolean;
}> {}

const transientAttemptError = (message: string) =>
  new GitHubAttemptError({ error: unavailable(message), transient: true });

const permanentAttemptError = (error: IssueTrackerError) =>
  new GitHubAttemptError({ error, transient: false });

const transientBackoff = Schedule.exponential("500 millis", 2).pipe(Schedule.jittered);
const paginationDeadline = "5 minutes";
const pageSize = 100;
const workContextCommentLimit = 10_000;
const workContextCommentByteLimit = 16 * 1024 * 1024;

const issueCommentBytes = (comment: RawIssueComment) =>
  Buffer.byteLength(comment.body) +
  Buffer.byteLength(comment.authorLogin ?? "") +
  Buffer.byteLength(comment.authorAssociation);

const withTransientAttemptDeadline = <A, R>(attempt: Effect.Effect<A, HttpClientError.HttpClientError, R>) =>
  attempt.pipe(
    Effect.catchTag("HttpClientError", (error) => Effect.fail(transientAttemptError(error.message))),
    Effect.timeout(transientAttemptDeadline),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(transientAttemptError(`GitHub request timed out after ${transientAttemptDeadline}`)),
    ),
  );

const openPullsPath = (repo: GitHubRepoRef, headBranch?: string) => {
  if (!headBranch) return "/pulls?state=open&per_page=100&sort=updated&direction=desc";
  const head = encodeURIComponent(`${repo.owner}:${headBranch}`);
  return `/pulls?state=open&head=${head}&per_page=100`;
};

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
  readonly nextLink: string | null;
}

const responseWithEtag = (body: unknown, etag: string | undefined, nextLink: string | null) => ({
  body,
  etag,
  nextLink,
});

type ConsumeResponse<A> = (
  response: HttpClientResponse.HttpClientResponse,
) => Effect.Effect<A, HttpClientError.HttpClientError>;

const acceptResponse = () => Effect.void;

const repoPath = (repo: GitHubRepoRef, suffix: string) =>
  `https://api.github.com/repos/${repo.owner}/${repo.name}${suffix}`;

const orgPath = (repo: GitHubRepoRef, suffix: string) => `https://api.github.com/orgs/${repo.owner}${suffix}`;

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
    const authenticated = request.pipe(
      HttpClientRequest.bearerToken(token),
      HttpClientRequest.setHeaders(baseHeaders),
    );
    const prepared = request.headers.accept
      ? HttpClientRequest.setHeader(authenticated, "accept", request.headers.accept)
      : authenticated;
    const response = yield* withTransientAttemptDeadline(client.execute(prepared));
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
          writeMayHaveCommitted: false,
        }),
      );
    }
    const forbidden =
      response.status === 403 ? yield* classifyForbiddenResponse(response, remaining) : "unknown";
    const throttled = response.status === 429 || forbidden === "rate-limited";
    if (throttled) {
      const until = resumeAt ?? now + Duration.toMillis(defaultTrackerCooldown);
      yield* Ref.set(resumeAtRef, until);
      return yield* permanentAttemptError(rateLimited(until));
    }
    if (isTransientStatus(response.status)) {
      return yield* transientAttemptError(`GitHub request failed (${response.status})`);
    }
    if (forbidden === "permission") {
      return yield* permanentAttemptError(
        new IssueTrackerError({
          reason: "unavailable",
          message: `GitHub request failed (${response.status})`,
          retryable: false,
          writeMayHaveCommitted: false,
        }),
      );
    }
    const idempotentDelete = request.method === "DELETE" && response.status === 404;
    if (response.status >= 400 && !idempotentDelete) {
      return yield* permanentAttemptError(unavailable(`GitHub request failed (${response.status})`, false));
    }
    return yield* withTransientAttemptDeadline(consume(response));
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
            permanentAttemptError(
              new IssueTrackerError({
                reason: "auth",
                message: error.message,
                writeMayHaveCommitted: false,
              }),
            ),
          ),
        );
      return yield* execute(request, credential.token, consume);
    }
    const token = yield* Effect.mapError(Config.redacted(repo.tokenEnv), () =>
      permanentAttemptError(
        new IssueTrackerError({
          reason: "auth",
          message: `missing GitHub token in ${repo.tokenEnv}`,
          writeMayHaveCommitted: false,
        }),
      ),
    );
    return yield* execute(request, token, consume);
  });

  const fetchJsonResponse = Effect.fn("github.fetchJsonResponse")(function* (
    repo: GitHubRepoRef,
    path: string,
  ) {
    const cached = (yield* Ref.get(etags)).get(path);
    const base = HttpClientRequest.get(path);
    const request = cached ? HttpClientRequest.setHeader(base, "if-none-match", cached.etag) : base;
    const response = yield* withTransientRetry(
      send(repo, request, (response) => {
        if (response.status === 304 && cached) {
          return Effect.succeed(responseWithEtag(cached.body, undefined, cached.nextLink));
        }
        return Effect.map(response.json, (body) =>
          responseWithEtag(body, response.headers.etag, response.headers.link ?? null),
        );
      }),
    );
    const etag = response.etag;
    if (etag !== undefined) {
      yield* Ref.update(etags, (entries) =>
        new Map(entries).set(path, { etag, body: response.body, nextLink: response.nextLink }),
      );
    }
    return response;
  });

  const fetchJson = Effect.fn("github.fetchJson")(function* (repo: GitHubRepoRef, path: string) {
    return (yield* fetchJsonResponse(repo, path)).body;
  });

  const fetchUncachedJsonResponse = Effect.fn("github.fetchUncachedJsonResponse")(function* (
    repo: GitHubRepoRef,
    path: string,
  ) {
    return yield* withTransientRetry(
      send(repo, HttpClientRequest.get(path), (response) =>
        Effect.map(response.json, (body) => ({ body, nextLink: response.headers.link ?? null })),
      ),
    );
  });

  const linkedPageNumber = Effect.fn("github.linkedPageNumber")(function* (
    header: string | undefined,
    expectedPath: string,
    canonicalPath: RegExp,
    label: string,
  ) {
    const link = header?.split(",").find((part) => part.includes('rel="next"'));
    if (!link) return null;
    const candidateUrl = /^<([^>]+)>/.exec(link.trim())?.[1];
    const url = candidateUrl && URL.canParse(candidateUrl) ? new URL(candidateUrl) : null;
    const page = url?.searchParams.get("page");
    const validLink =
      url?.origin === "https://api.github.com" &&
      (url.pathname === expectedPath || canonicalPath.test(url.pathname)) &&
      typeof page === "string" &&
      /^[1-9]\d*$/.test(page);
    if (!validLink) return yield* unavailable(`GitHub ${label} pagination returned an invalid next link`);
    return page;
  });

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

  const issueCommentPagePath = Effect.fn("github.issueCommentPagePath")(function* (
    repo: GitHubRepoRef,
    issueNumber: number,
    header: string | undefined,
  ) {
    const expectedPath = `/repos/${repo.owner}/${repo.name}/issues/${issueNumber}/comments`;
    const canonicalPath = new RegExp(`^/repositories/[1-9]\\d*/issues/${issueNumber}/comments$`);
    const page = yield* linkedPageNumber(header, expectedPath, canonicalPath, "issue comment");
    return page === null ? null : repoPath(repo, `/issues/${issueNumber}/comments?per_page=100&page=${page}`);
  });

  interface IssueCommentPages {
    readonly pages: ReadonlyArray<ReadonlyArray<RawIssueComment>>;
    readonly visited: ReadonlySet<string>;
    readonly commentCount: number;
    readonly commentBytes: number;
  }

  const collectIssueCommentPages: (
    repo: GitHubRepoRef,
    issueNumber: number,
    path: string,
    enforceAdmissionLimit: boolean,
    state?: IssueCommentPages,
  ) => Effect.Effect<ReadonlyArray<RawIssueComment>, IssueTrackerError> = Effect.fn(
    "github.collectIssueCommentPages",
  )(function* (
    repo,
    issueNumber,
    path,
    enforceAdmissionLimit,
    state = { pages: [], visited: new Set(), commentCount: 0, commentBytes: 0 },
  ) {
    if (state.visited.has(path)) {
      return yield* unavailable("GitHub issue comment pagination returned a repeated next link");
    }
    const response = yield* fetchUncachedJsonResponse(repo, path);
    const nextPath = yield* issueCommentPagePath(repo, issueNumber, response.nextLink ?? undefined);
    const comments = yield* parseIssueComments(response.body);
    const commentCount = state.commentCount + comments.length;
    const commentBytes =
      state.commentBytes + comments.reduce((total, comment) => total + issueCommentBytes(comment), 0);
    const withinAdmissionLimit =
      commentCount <= workContextCommentLimit && commentBytes <= workContextCommentByteLimit;
    if (enforceAdmissionLimit && !withinAdmissionLimit) {
      return yield* new IssueTrackerError({
        reason: "unavailable",
        retryable: false,
        message: `GitHub issue thread exceeds admission limits (${workContextCommentLimit} comments or ${workContextCommentByteLimit} bytes)`,
      });
    }
    const nextState = {
      pages: [...state.pages, comments],
      visited: new Set(state.visited).add(path),
      commentCount,
      commentBytes,
    };
    if (nextPath === null) return nextState.pages.flat();
    return yield* collectIssueCommentPages(repo, issueNumber, nextPath, enforceAdmissionLimit, nextState);
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
    const withBody = yield* Effect.mapError(HttpClientRequest.bodyJson(request, body), (error) =>
      unavailable(error.message, false),
    );
    const response = yield* send(repo, withBody, Effect.succeed).pipe(
      Effect.mapError((error) => error.error),
    );
    return yield* response.json.pipe(
      Effect.option,
      Effect.timeoutOption(transientAttemptDeadline),
      Effect.map(Option.flatten),
    );
  });

  const sendAcceptedOnce = Effect.fn("github.sendAcceptedOnce")(function* (
    repo: GitHubRepoRef,
    request: HttpClientRequest.HttpClientRequest,
    body: unknown,
  ) {
    const withBody = yield* Effect.mapError(HttpClientRequest.bodyJson(request, body), (error) =>
      unavailable(error.message, false),
    );
    yield* send(repo, withBody, acceptResponse).pipe(Effect.mapError((error) => error.error));
  });

  const addLabel = Effect.fn("github.addLabel")((repo: GitHubRepoRef, issueNumber: number, label: string) =>
    sendJson(repo, HttpClientRequest.post(repoPath(repo, `/issues/${issueNumber}/labels`)), {
      labels: [label],
    }),
  );

  const createIssue = Effect.fn("github.createIssue")(function* (
    repo: GitHubRepoRef,
    input: GitHubIssueCreateInput,
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
    if (Option.isNone(acceptedBody)) {
      return yield* unavailable("GitHub accepted issue creation but its response was unavailable", true);
    }
    return yield* Effect.gen(function* () {
      const created = yield* Effect.mapError(decodeIssue(acceptedBody.value), toUnavailable);
      const applied = new Set(created.labels.map(labelName));
      yield* Effect.forEach(
        input.labels.filter((label) => !applied.has(label)),
        (label) => addLabel(repo, created.number, label),
      );
      return toRawIssue(repo, created);
    }).pipe(Effect.mapError(toAcceptedWriteError));
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

  const createComment = Effect.fn("github.createComment")(function* (
    repo: GitHubRepoRef,
    issueNumber: number,
    body: string,
  ) {
    yield* sendAcceptedOnce(repo, HttpClientRequest.post(repoPath(repo, `/issues/${issueNumber}/comments`)), {
      body,
    });
  });

  const listCollaborators = Effect.fn("github.listCollaborators")(function* (repo: GitHubRepoRef) {
    const collect: (page?: number) => Effect.Effect<ReadonlyArray<string>, IssueTrackerError> = Effect.fn(
      "github.collectCollaboratorPages",
    )(function* (page = 1) {
      const json = yield* fetchJson(
        repo,
        repoPath(repo, `/collaborators?affiliation=all&per_page=100&page=${page}`),
      );
      const users = yield* Effect.mapError(
        Schema.decodeUnknownEffect(GitHubCollaboratorsSchema)(json),
        toUnavailable,
      );
      const current = users.map(({ login }) => login);
      if (current.length < 100) return current;
      return [...current, ...(yield* collect(page + 1))];
    });
    return yield* withPaginationDeadline(collect());
  });

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
    yield* sendJson(repo, HttpClientRequest.post(repoPath(repo, `/pulls/${pullNumber}/reviews`)), {
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
    } satisfies RawPullDetail;
  });

  const listPullFiles = Effect.fn("github.listPullFiles")(function* (
    repo: GitHubRepoRef,
    pullNumber: number,
  ) {
    const collect: (page?: number) => Effect.Effect<ReadonlyArray<RawPullFile>, IssueTrackerError> =
      Effect.fn("github.collectPullFilePages")(function* (page = 1) {
        const json = yield* fetchJson(
          repo,
          repoPath(repo, `/pulls/${pullNumber}/files?per_page=100&page=${page}`),
        );
        const decoded = yield* Effect.mapError(decodePullFiles(json), toUnavailable);
        const current = decoded.map((file) => ({
          path: file.filename,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.changes,
          patch: file.patch ?? null,
        }));
        return current.length < 100 ? current : [...current, ...(yield* collect(page + 1))];
      });
    return yield* withPaginationDeadline(collect());
  });

  const createPerformanceComment = Effect.fn("github.createPerformanceComment")(function* (
    repo: GitHubRepoRef,
    issueNumber: number,
    body: string,
  ) {
    yield* createComment(repo, issueNumber, body).pipe(
      Effect.catchIf(
        (error) => error.writeMayHaveCommitted !== false,
        () => Effect.void,
      ),
    );
  });

  interface IssueQuery {
    readonly state: "open" | "all";
    readonly label?: string;
    readonly since?: number;
  }

  const issuePagePath = (query: IssueQuery, page: number) => {
    const parameters = new URLSearchParams({
      state: query.state,
      per_page: String(pageSize),
      page: String(page),
    });
    if (query.label) parameters.set("labels", query.label);
    if (query.since !== undefined) {
      parameters.set("sort", "updated");
      parameters.set("direction", "asc");
      parameters.set("since", isoMillis(query.since));
    }
    return `/issues?${parameters}`;
  };

  const collectIssueFieldValuePages: (
    repo: GitHubRepoRef,
    states: ReadonlyArray<IssueFieldValueState>,
  ) => Effect.Effect<ReadonlyArray<IssueFieldValueState>, IssueTrackerError> = Effect.fn(
    "github.collectIssueFieldValuePages",
  )(function* (repo, states) {
    const pending = states.filter((state) => state.cursor !== null);
    if (pending.length === 0) return states;
    const data = yield* graphql(
      repo,
      issueFieldValuePagesQuery(pending.length),
      issueFieldValuePageVariables(pending),
    );
    const payload = yield* Effect.mapError(decodeIssueFieldValuePages(data), toUnavailable);
    const continued = pending.map((state, index) =>
      continuedIssueFieldValueState(state, payload[`issue${index}`]),
    );
    const continuedById = new Map(continued.map((state) => [state.nodeId, state] as const));
    return yield* collectIssueFieldValuePages(
      repo,
      states.map((state) => continuedById.get(state.nodeId) ?? state),
    );
  });

  const collectIssueFieldValues = Effect.fn("github.collectIssueFieldValues")(function* (
    repo: GitHubRepoRef,
    issueNodeIds: ReadonlyArray<string>,
  ) {
    const data = yield* graphql(repo, issueFieldValuesQuery, { ids: issueNodeIds });
    const payload = yield* Effect.mapError(decodeIssueFieldValues(data), toUnavailable);
    const states = payload.nodes.flatMap((issue) => (issue ? [issueFieldValueState(issue, new Map())] : []));
    const completed = yield* collectIssueFieldValuePages(repo, states);
    return issueFieldValuesByIssue(completed);
  });

  const collectIssuePages: (
    repo: GitHubRepoRef,
    query: IssueQuery,
    page?: number,
  ) => Effect.Effect<ReadonlyArray<RawIssue>, IssueTrackerError> = Effect.fn("github.collectIssuePages")(
    function* (repo, query, page = 1) {
      const json = yield* fetchJson(repo, repoPath(repo, issuePagePath(query, page)));
      const current = yield* parseIssues(repo, json);
      if (current.length < pageSize) return current;
      const remaining = yield* collectIssuePages(repo, query, page + 1);
      return [...current, ...remaining];
    },
  );

  return {
    authenticatedLogin: Effect.fn("github.authenticatedLogin")(function* (repo: GitHubRepoRef) {
      const json = yield* withTransientRetry(
        send(repo, HttpClientRequest.get("https://api.github.com/user"), (response) => response.json),
      );
      const user = yield* Effect.mapError(decodeAuthenticatedUser(json), toUnavailable);
      return user.login;
    }),
    listIssues: Effect.fn("github.listIssues")(function* (
      repo: GitHubRepoRef,
      query: IssueQuery = { state: "open" },
    ) {
      return yield* withPaginationDeadline(collectIssuePages(repo, query));
    }),
    readIssue: (repo: GitHubRepoRef, issueNumber: number) =>
      fetchJson(repo, repoPath(repo, `/issues/${issueNumber}`)).pipe(
        Effect.flatMap((json) => Effect.mapError(decodeIssue(json), toUnavailable)),
        Effect.map((issue) => toRawIssue(repo, issue)),
      ),
    findIssueWithMarker: Effect.fn("github.findIssueWithMarker")(function* (
      repo: GitHubRepoRef,
      marker: string,
    ) {
      const query = new URLSearchParams({
        q: `repo:${repo.owner}/${repo.name} is:issue in:body "${marker}"`,
        per_page: "100",
      });
      const { body: json } = yield* fetchUncachedJsonResponse(
        repo,
        `https://api.github.com/search/issues?${query}`,
      );
      const payload = yield* Effect.mapError(decodeSearchIssues(json), toUnavailable);
      const issue = payload.items.find(({ body }) => body?.includes(marker));
      return issue ? toRawIssue(repo, issue) : null;
    }),
    listIssueFieldValues: Effect.fn("github.listIssueFieldValues")(function* (
      repo: GitHubRepoRef,
      issueNodeIds: ReadonlyArray<string>,
    ) {
      if (issueNodeIds.length === 0) return new Map();
      return yield* withPaginationDeadline(collectIssueFieldValues(repo, issueNodeIds));
    }),
    listPriorityFields: Effect.fn("github.listPriorityFields")(function* (repo: GitHubRepoRef) {
      const json = yield* fetchJson(repo, orgPath(repo, "/issue-fields")).pipe(
        Effect.mapError((error) => priorityFieldReadError(repo, error)),
      );
      const fields = yield* Effect.mapError(decodeIssueFields(json), toUnavailable);
      return fields
        .filter((field) => field.data_type === "single_select")
        .map(({ id, name }) => ({ id, name }) satisfies GitHubPriorityField);
    }),
    listPulls: Effect.fn("github.listPulls")(function* (repo: GitHubRepoRef, headBranch?: string) {
      const pulls = yield* readPulls(repo, headBranch);
      const references = yield* pullReferences(repo, headBranch);
      return pulls.map(
        (pull): RawPull => ({
          number: pull.number,
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
        }),
      );
    }),
    getPull,
    getPullDiff: Effect.fn("github.getPullDiff")(function* (repo: GitHubRepoRef, pullNumber: number) {
      return yield* withTransientRetry(
        send(
          repo,
          HttpClientRequest.get(repoPath(repo, `/pulls/${pullNumber}`)).pipe(
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
    listComments: Effect.fn("github.listComments")(function* (repo: GitHubRepoRef, issueNumber: number) {
      const json = yield* fetchJson(repo, repoPath(repo, `/issues/${issueNumber}/comments?per_page=100`));
      return yield* parseIssueComments(json);
    }),
    listIssueEvents: Effect.fn("github.listIssueEvents")(function* (
      repo: GitHubRepoRef,
      issueNumber: number,
    ) {
      const collect: (page?: number) => Effect.Effect<ReadonlyArray<RawIssueEvent>, IssueTrackerError> =
        Effect.fn("github.collectIssueEventPages")(function* (page = 1) {
          const json = yield* fetchJson(
            repo,
            repoPath(repo, `/issues/${issueNumber}/events?per_page=100&page=${page}`),
          );
          const decoded = yield* Effect.mapError(
            Schema.decodeUnknownEffect(Schema.Array(IssueEventSchema))(json),
            toUnavailable,
          );
          const current = decoded.map((event) => ({
            id: event.id,
            event: event.event,
            labelName: event.label?.name ?? null,
            createdAtMillis: millisFromIso(event.created_at),
          }));
          if (current.length < 100) return current;
          return [...current, ...(yield* collect(page + 1))];
        });
      return yield* withPaginationDeadline(collect());
    }),
    listAllComments: Effect.fn("github.listAllComments")(function* (
      repo: GitHubRepoRef,
      issueNumber: number,
    ) {
      return yield* withPaginationDeadline(
        collectIssueCommentPages(
          repo,
          issueNumber,
          repoPath(repo, `/issues/${issueNumber}/comments?per_page=100`),
          true,
        ),
      );
    }),
    listTriggerComments: Effect.fn("github.listTriggerComments")(function* (
      repo: GitHubRepoRef,
      issueNumber: number,
    ) {
      return yield* withPaginationDeadline(
        collectIssueCommentPages(
          repo,
          issueNumber,
          repoPath(repo, `/issues/${issueNumber}/comments?per_page=100`),
          false,
        ),
      );
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
        const current = decoded.check_runs.map(
          (run): CheckRun => ({
            name: run.name,
            status: run.status,
            conclusion: run.conclusion,
            startedAtMillis: millisFromIso(run.started_at),
            completedAtMillis: millisFromIso(run.completed_at),
          }),
        );
        if (current.length < 100) return current;
        return [...current, ...(yield* collect(page + 1))];
      });
      return withPaginationDeadline(collect());
    },
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
    closeIssue: (repo: GitHubRepoRef, issueNumber: number) =>
      sendAcceptedOnce(repo, HttpClientRequest.patch(repoPath(repo, `/issues/${issueNumber}`)), {
        state: "closed",
      }),
    createComment,
    listCollaborators,
    listRequestedReviewers,
    requestReview,
    createReview,
    createPerformanceComment,
    editComment: (repo: GitHubRepoRef, commentId: number, body: string) =>
      sendJson(repo, HttpClientRequest.patch(repoPath(repo, `/issues/comments/${commentId}`)), { body }),
    verifyCredential: (token: Redacted.Redacted<string>) =>
      execute(HttpClientRequest.get("https://api.github.com/user"), token, (response) => response.json).pipe(
        Effect.mapError((error) => error.error),
        Effect.flatMap((body) => Effect.mapError(decodeAuthenticatedUser(body), toUnavailable)),
        Effect.map((user) => user.login),
      ),
  };
});

export type GitHubClientService = Effect.Success<ReturnType<typeof make>>;

export class GitHubClient extends Context.Service<GitHubClient, GitHubClientService>()(
  "@cogwork/engine/github/client/GitHubClient",
) {}

export const layer = Layer.effect(
  GitHubClient,
  Effect.flatMap(HttpClient.HttpClient, (client) => make(client)),
);
