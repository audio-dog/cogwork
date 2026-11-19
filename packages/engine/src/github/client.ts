import type { ConnectionId } from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import { makeIssueClient } from "./client-issues";
import { makePullClient } from "./client-pulls";
import { decodeAuthenticatedUser } from "./client-responses";
import { makeTransport, toUnavailable, withTransientRetry } from "./client-transport";

export interface GitHubRepoRef {
  readonly owner: string;
  readonly name: string;
  readonly tokenEnv: string;
  readonly connectionId?: ConnectionId;
}

export interface GitHubIssueCreateInput {
  readonly title?: string;
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
  readonly title?: string;
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
  readonly mergeableState: string | null;
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

const standingStates = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);

const reviewDecisionOf = (
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

const writeAccess = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export const writeAccessReviewDecision = (reviews: ReadonlyArray<RawReview>) =>
  reviewDecisionOf(
    reviews
      .filter((review) => writeAccess.has(review.authorAssociation))
      .map((review) => ({ login: review.authorLogin, state: review.state })),
  );

const make = Effect.fn("github.client.make")(function* (client: HttpClient.HttpClient) {
  const transport = yield* makeTransport(client);
  const { execute, send } = transport;

  return {
    authenticatedLogin: Effect.fn("github.authenticatedLogin")(function* (repo: GitHubRepoRef) {
      const json = yield* withTransientRetry(
        send(repo, HttpClientRequest.get("https://api.github.com/user"), (response) => response.json),
      );
      const user = yield* Effect.mapError(decodeAuthenticatedUser(json), toUnavailable);
      return user.login;
    }),
    ...makeIssueClient(transport),
    ...makePullClient(transport),
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
