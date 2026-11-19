import { type Priority, resolvePriority } from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { unavailable } from "./client-errors";
import { isResolvedState } from "./client-queries";
import type {
  ActionIssueNode,
  CommentNode,
  IssueNode,
  PageInfoNode,
  ProseCommentNode,
  RelationNode,
} from "./client-schemas";

export interface RawIssue {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly url: string;
  readonly body?: string;
  readonly labels: ReadonlyArray<string>;
  readonly assignees: ReadonlyArray<string>;
  readonly stateName: string;
  readonly stateType: string;
  readonly openBlockers: number;
  readonly priority: Priority;
  readonly createdAtMillis?: number;
  readonly updatedAtMillis: number;
}

export interface ObservedRawIssue extends RawIssue {
  readonly coordinationComments: ReadonlyArray<RawComment>;
}

type LinearAuthorAssociation = "MEMBER" | "NONE" | "OWNER";

export interface RawComment {
  readonly id: string;
  readonly authorId: string | null;
  readonly authorAssociation: LinearAuthorAssociation;
  readonly body: string;
  readonly createdAtMillis: number;
}

export const millisFromIso = (value: string) => {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
};

export const isOpenBlocker = (relation: typeof RelationNode.Type) =>
  relation.type === "blocks" && !isResolvedState(relation.issue.state.type);

export const countOpenBlockers = (relations: ReadonlyArray<typeof RelationNode.Type>) =>
  relations.filter(isOpenBlocker).length;

export const continuationCursor = Effect.fn("linear.continuationCursor")(function* (
  pageInfo: typeof PageInfoNode.Type,
  issueIdentifier: string,
  kind = "relation",
) {
  return yield* pageInfo.hasNextPage
    ? Option.match(Option.fromNullOr(pageInfo.endCursor), {
        onNone: () => Effect.fail(unavailable(`Linear ${kind} page missing cursor: ${issueIdentifier}`)),
        onSome: (cursor) => Effect.succeed(Option.some(cursor)),
      })
    : Effect.succeed(Option.none<string>());
});

// Linear uses 0 for "No priority"; anything outside 1-4 resolves to the default.
const linearPriorityNames: Record<number, string> = { 1: "urgent", 2: "high", 3: "medium", 4: "low" };
export const linearPriority = (value: number | undefined): Priority =>
  resolvePriority(value === undefined ? null : linearPriorityNames[value]);

export const toRawIssue = (issue: typeof IssueNode.Type, openBlockers: number) => ({
  id: issue.id,
  identifier: issue.identifier,
  title: issue.title,
  url: issue.url,
  body: issue.description ?? "",
  labels: issue.labels.nodes.map((label) => label.name),
  assignees: issue.assignee ? [issue.assignee.id] : [],
  stateName: issue.state.name,
  stateType: issue.state.type,
  openBlockers,
  priority: linearPriority(issue.priority),
  createdAtMillis: millisFromIso(issue.createdAt ?? issue.updatedAt ?? ""),
  updatedAtMillis: millisFromIso(issue.updatedAt ?? ""),
});

export const toActionIssue = (issue: typeof ActionIssueNode.Type) => ({
  id: issue.id,
  identifier: issue.identifier,
  url: issue.url,
  body: issue.description ?? "",
  labels: issue.labels.nodes.map(({ name }) => name),
  stateType: issue.state.type,
});

export const toRawComment = (comment: typeof CommentNode.Type) => {
  const rawComment: RawComment = {
    id: comment.id,
    authorId: comment.user?.id ?? null,
    authorAssociation: "NONE",
    body: comment.body,
    createdAtMillis: millisFromIso(comment.createdAt),
  };
  return rawComment;
};

const lacksSteeringAuthority = (user: NonNullable<(typeof ProseCommentNode.Type)["user"]>) =>
  !user.active || user.guest || user.app;

const authorAssociationRules = [
  { when: lacksSteeringAuthority, value: "NONE" },
  { when: (user: NonNullable<(typeof ProseCommentNode.Type)["user"]>) => user.admin, value: "OWNER" },
] as const;

const authorAssociationOf = (user: (typeof ProseCommentNode.Type)["user"]): LinearAuthorAssociation =>
  user === null ? "NONE" : (authorAssociationRules.find(({ when }) => when(user))?.value ?? "MEMBER");

export const toRawProseComment = (comment: typeof ProseCommentNode.Type) => ({
  id: comment.id,
  authorId: comment.user?.id ?? null,
  authorAssociation: authorAssociationOf(comment.user),
  body: comment.body,
  createdAtMillis: millisFromIso(comment.createdAt),
});

export const rawCommentBytes = (comment: RawComment) =>
  Buffer.byteLength(comment.body) + Buffer.byteLength(comment.authorId ?? "");

export const toObservedIssue = (issue: typeof IssueNode.Type, openBlockers: number): ObservedRawIssue => ({
  ...toRawIssue(issue, openBlockers),
  coordinationComments: [...(issue.comments?.nodes ?? []), ...(issue.proposalComments?.nodes ?? [])].map(
    toRawComment,
  ),
});
