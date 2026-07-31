import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { WorkSourceError } from "../WorkSource";

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
  readonly isPullRequest: boolean;
}

export interface RawPull {
  readonly number: number;
  readonly authorLogin: string;
  readonly body: string;
  readonly draft: boolean;
  readonly reviewDecision: ReviewDecision;
}

export interface RawComment {
  readonly id: number;
  readonly authorLogin: string;
  readonly body: string;
}

const baseHeaders = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "clanker-forge",
};

const LabelName = Schema.Union([Schema.String, Schema.Struct({ name: Schema.String })]);
const labelName = (label: typeof LabelName.Type) => (typeof label === "string" ? label : label.name);

const IssueSchema = Schema.Struct({
  number: Schema.Finite,
  title: Schema.String,
  labels: Schema.Array(LabelName),
  pull_request: Schema.optional(Schema.Unknown),
});

const PullSchema = Schema.Struct({
  number: Schema.Finite,
  user: Schema.Struct({ login: Schema.String }),
  body: Schema.NullOr(Schema.String),
  draft: Schema.optional(Schema.Boolean),
});

const ReviewSchema = Schema.Struct({
  state: Schema.String,
  user: Schema.Struct({ login: Schema.String }),
});

const CommentSchema = Schema.Struct({
  id: Schema.Finite,
  body: Schema.NullOr(Schema.String),
  user: Schema.Struct({ login: Schema.String }),
});

const decodeIssues = Schema.decodeUnknownEffect(Schema.Array(IssueSchema));
const decodePulls = Schema.decodeUnknownEffect(Schema.Array(PullSchema));
const decodeReviews = Schema.decodeUnknownEffect(Schema.Array(ReviewSchema));
const decodeComments = Schema.decodeUnknownEffect(Schema.Array(CommentSchema));

const unavailable = (message: string) => new WorkSourceError({ reason: "unavailable", message });
const toUnavailable = (error: { readonly message: string }) => unavailable(error.message);

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

const make = (client: HttpClient.HttpClient) => {
  const send = Effect.fn("github.send")(function* (
    repo: GitHubRepoRef,
    request: HttpClientRequest.HttpClientRequest,
  ) {
    const token = yield* Effect.mapError(
      Config.redacted(repo.tokenEnv),
      () => new WorkSourceError({ reason: "auth", message: `missing GitHub token in ${repo.tokenEnv}` }),
    );
    const response = yield* Effect.catchTag(
      client.execute(
        request.pipe(HttpClientRequest.bearerToken(token), HttpClientRequest.setHeaders(baseHeaders)),
      ),
      "HttpClientError",
      (error) => Effect.fail(unavailable(error.message)),
    );
    if (response.status === 401) {
      return yield* new WorkSourceError({ reason: "auth", message: "GitHub authentication failed (401)" });
    }
    if (response.status >= 400) {
      return yield* unavailable(`GitHub request failed (${response.status})`);
    }
    return response;
  });

  const fetchJson = Effect.fn("github.fetchJson")(function* (repo: GitHubRepoRef, path: string) {
    const response = yield* send(repo, HttpClientRequest.get(path));
    return yield* Effect.mapError(response.json, toUnavailable);
  });

  const reviewDecisionFor = Effect.fn("github.reviewDecision")(function* (
    repo: GitHubRepoRef,
    pullNumber: number,
  ) {
    const json = yield* fetchJson(repo, repoPath(repo, `/pulls/${pullNumber}/reviews?per_page=100`));
    const reviews = yield* Effect.mapError(decodeReviews(json), toUnavailable);
    return reviewDecisionOf(reviews.map((review) => ({ login: review.user.login, state: review.state })));
  });

  const sendJson = Effect.fn("github.sendJson")(function* (
    repo: GitHubRepoRef,
    request: HttpClientRequest.HttpClientRequest,
    body: unknown,
  ) {
    const withBody = yield* Effect.mapError(HttpClientRequest.bodyJson(request, body), toUnavailable);
    yield* send(repo, withBody);
  });

  return {
    listIssues: (repo: GitHubRepoRef) =>
      Effect.gen(function* () {
        const json = yield* fetchJson(repo, repoPath(repo, "/issues?state=open&per_page=100"));
        const issues = yield* Effect.mapError(decodeIssues(json), toUnavailable);
        return issues.map(
          (issue): RawIssue => ({
            number: issue.number,
            title: issue.title,
            labels: issue.labels.map(labelName),
            isPullRequest: issue.pull_request !== undefined,
          }),
        );
      }),
    listPulls: (repo: GitHubRepoRef) =>
      Effect.gen(function* () {
        const json = yield* fetchJson(repo, repoPath(repo, "/pulls?state=open&per_page=100"));
        const pulls = yield* Effect.mapError(decodePulls(json), toUnavailable);
        return yield* Effect.forEach(pulls, (pull) =>
          Effect.map(
            reviewDecisionFor(repo, pull.number),
            (decision): RawPull => ({
              number: pull.number,
              authorLogin: pull.user.login,
              body: pull.body ?? "",
              draft: pull.draft ?? false,
              reviewDecision: decision,
            }),
          ),
        );
      }),
    listComments: (repo: GitHubRepoRef, issueNumber: number) =>
      Effect.gen(function* () {
        const json = yield* fetchJson(repo, repoPath(repo, `/issues/${issueNumber}/comments?per_page=100`));
        const comments = yield* Effect.mapError(decodeComments(json), toUnavailable);
        return comments.flatMap((comment) =>
          comment.body
            ? [{ id: comment.id, authorLogin: comment.user.login, body: comment.body }]
            : [],
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
};

export type GitHubClientService = ReturnType<typeof make>;

export class GitHubClient extends Context.Service<GitHubClient, GitHubClientService>()(
  "@clanker-forge/engine/github/client/GitHubClient",
) {}

export const layer = Layer.effect(
  GitHubClient,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return make(client);
  }),
);
