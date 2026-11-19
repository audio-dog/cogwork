import { GitHubIssueFieldId, TrimmedNonEmptyString } from "@cogwork/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { OpenedPullRequest } from "../source-control";
import type { GitHubRepoRef, RawIssue, RawReviewComment } from "./client";
import { toUnavailable } from "./client-transport";

const LabelName = Schema.Union([Schema.String, Schema.Struct({ name: Schema.String })]);
export const labelName = (label: typeof LabelName.Type) => (typeof label === "string" ? label : label.name);

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

export const PullSchema = Schema.Struct({
  number: Schema.Finite,
  title: Schema.String,
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
export const PullMergeableStateSchema = Schema.Struct({
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
const CompareSchema = Schema.Struct({ files: Schema.Array(PullFileSchema) });

const GitHubUserSchema = Schema.Struct({ login: Schema.String, type: Schema.optional(Schema.String) });
export const GitHubCollaboratorsSchema = Schema.Array(GitHubUserSchema);
export const GitHubLabelsSchema = Schema.Array(Schema.Struct({ name: Schema.String }));
export const RequestedReviewersSchema = Schema.Struct({ users: Schema.Array(GitHubUserSchema) });

const ReviewSchema = Schema.Struct({
  id: Schema.Finite,
  state: Schema.String,
  user: Schema.NullOr(GitHubUserSchema),
  body: Schema.NullOr(Schema.String),
  author_association: Schema.optional(Schema.String),
  submitted_at: Schema.optional(Schema.NullOr(Schema.String)),
});

export const IssueEventSchema = Schema.Struct({
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

export const toRawReviewComment = ({ user, ...comment }: typeof ReviewCommentSchema.Type) =>
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

const decodeIssues = Schema.decodeUnknownEffect(Schema.Array(IssueSchema));
export const decodeIssue = Schema.decodeUnknownEffect(IssueSchema);
export const decodeSearchIssues = Schema.decodeUnknownEffect(SearchIssuesSchema);
export const decodeIssueFields = Schema.decodeUnknownEffect(Schema.Array(GitHubIssueFieldSchema));
export const decodeAuthenticatedUser = Schema.decodeUnknownEffect(AuthenticatedUserSchema);
export const decodeCreatedPull = Schema.decodeUnknownEffect(CreatedPullSchema);
export const decodeCreatedPulls = Schema.decodeUnknownEffect(Schema.Array(CreatedPullSchema));
export const decodePulls = Schema.decodeUnknownEffect(Schema.Array(PullSchema));
export const decodePullDetail = Schema.decodeUnknownEffect(PullDetailSchema);
export const decodeCompare = Schema.decodeUnknownEffect(CompareSchema);
export const decodeReviews = Schema.decodeUnknownEffect(Schema.Array(ReviewSchema));
const decodeIssueComments = Schema.decodeUnknownEffect(Schema.Array(IssueCommentSchema));
export const decodeReviewComments = Schema.decodeUnknownEffect(Schema.Array(ReviewCommentSchema));

export const commentMillis = (iso: string) =>
  DateTime.make(iso).pipe(
    Option.map(DateTime.toEpochMillis),
    Option.getOrElse(() => 0),
  );
export const decodeCheckRuns = Schema.decodeUnknownEffect(CheckRunsSchema);

export const millisFromIso = (value: string | null) => {
  const parsed = value === null ? Number.NaN : Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
};

export const toRawIssue = (repo: GitHubRepoRef, issue: typeof IssueSchema.Type): RawIssue => ({
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

export const openedPull = (created: typeof CreatedPullSchema.Type) =>
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
