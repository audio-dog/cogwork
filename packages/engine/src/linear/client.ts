import type { LinearClient as LinearSdk } from "@linear/sdk";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { CredentialStore, type CredentialStoreService } from "../credential-store";
import { IssueTrackerError } from "../issue-tracker";
import {
  classifyCreateFailure,
  markWriteMayHaveCommitted,
  toUnavailable,
  unavailable,
  withPaginationDeadline,
} from "./client-errors";
import {
  continuationCursor,
  type RawIssue,
  rawCommentBytes,
  toActionIssue,
  toRawComment,
  toRawIssue,
  toRawProseComment,
} from "./client-issue-mapping";
import { type CoordinationScope, makeIssueReads } from "./client-issue-reads";
import {
  actionIssueMarkerShape,
  actionIssueQuery,
  commentsQuery,
  coordinationCommentsQuery,
  issueAssigneesQuery,
  issueLabelQuery,
  issueMarkerQuery,
  labelNames,
  labelShape,
  metaShape,
  triggerIssueQuery,
  workContextCommentLimit,
  workContextProseByteLimit,
  workspaceLabelQuery,
} from "./client-queries";
import {
  type CommentPage,
  type CommentPaginationState,
  decodeActionIssue,
  decodeComments,
  decodeCoordinationComments,
  decodeIssueAssignees,
  decodeIssueLabel,
  decodeIssueMarker,
  decodeTriggerIssue,
  decodeWorkspaceLabels,
} from "./client-schemas";
import { type LinearTeamRef, makeTransport, requireSuccess } from "./client-transport";

export interface RawWorkflowState {
  readonly id: string;
  readonly name: string;
  readonly type: string;
}

export interface RawLabel {
  readonly id: string;
  readonly name: string;
}

const labelCreateRefused = (ref: LinearTeamRef, name: string) => (error: IssueTrackerError) =>
  new IssueTrackerError({
    reason: error.reason,
    message: `Linear refused creating the "${name}" label in team ${ref.team}: ${error.message}`,
    retryable: error.reason === "rate-limited" || error.retryable === true,
    retryAfterMillis: error.retryAfterMillis,
    connectionId: error.connectionId,
  });

const make = Effect.fn("linear.client.make")(function* (credentials: CredentialStoreService) {
  const transport = yield* makeTransport(credentials);
  const { credentialFor, callWithCredential, call, callOnce, rawData } = transport;
  const {
    openBlockersOf,
    loadTeam,
    observeIssues,
    observeOpenIssuesSince,
    observeLabelledIssues,
    labelAppliedAt,
  } = makeIssueReads(transport);

  const mutate = Effect.fn("linear.mutate")(function* (
    ref: LinearTeamRef,
    operation: string,
    run: (sdk: LinearSdk) => PromiseLike<{ readonly success: boolean }>,
  ) {
    const payload = yield* callOnce(ref, run);
    yield* requireSuccess(operation, payload);
  });

  const resolveLabel = Effect.fn("linear.resolveLabel")(function* (ref: LinearTeamRef, name: string) {
    const team = yield* loadTeam(ref, labelShape, { label: name });
    const scoped = team.labels.nodes.at(0);
    if (scoped) return { teamId: team.id, labelId: scoped.id };
    const data = yield* rawData(ref, workspaceLabelQuery, { label: name });
    const payload = yield* Effect.mapError(decodeWorkspaceLabels(data), toUnavailable);
    return { teamId: team.id, labelId: payload.issueLabels.nodes.at(0)?.id ?? null };
  });

  // Team labels and workspace labels both apply to the team's issues.
  const listLabels = Effect.fn("linear.listLabels")(function* (ref: LinearTeamRef) {
    const team = yield* loadTeam(ref, metaShape);
    return yield* call(ref, (sdk) =>
      sdk
        .issueLabels({
          filter: { or: [{ team: { id: { eq: team.id } } }, { team: { null: true } }] },
          first: 250,
        })
        .then(labelNames),
    );
  });

  const ensureLabel = Effect.fn("linear.ensureLabel")(function* (ref: LinearTeamRef, name: string) {
    const { teamId, labelId } = yield* resolveLabel(ref, name);
    if (labelId !== null) return labelId;
    const payload = yield* Effect.mapError(
      callOnce(ref, (sdk) => sdk.createIssueLabel({ teamId, name })),
      labelCreateRefused(ref, name),
    );
    yield* requireSuccess("issueLabelCreate", payload);
    if (!payload.issueLabelId) {
      return yield* unavailable(`Linear issueLabelCreate returned no label for ${name}`);
    }
    return payload.issueLabelId;
  });

  const createIssue = Effect.fn("linear.createIssue")(function* (
    ref: LinearTeamRef,
    input: { readonly title: string; readonly body: string; readonly labels: ReadonlyArray<string> },
  ) {
    interface CreatedIssue {
      readonly success: boolean;
      readonly issue: { readonly id: string; readonly identifier: string; readonly url: string } | null;
    }
    const team = yield* loadTeam(ref, metaShape);
    const labelIds = yield* Effect.forEach(input.labels, (label) => ensureLabel(ref, label));
    const payload = yield* callOnce(ref, (sdk) =>
      sdk
        .createIssue({
          teamId: team.id,
          title: input.title,
          description: input.body,
          labelIds,
        })
        .then((created): Promise<CreatedIssue> => {
          const issue = created.issue;
          return issue === undefined
            ? Promise.resolve({ success: created.success, issue: null })
            : issue.then((value) => ({
                success: created.success,
                issue: { id: value.id, identifier: value.identifier, url: value.url },
              }));
        }),
    ).pipe(Effect.mapError(classifyCreateFailure));
    yield* requireSuccess("issueCreate", payload);
    if (payload.issue === null) {
      return yield* markWriteMayHaveCommitted(unavailable("Linear issueCreate returned no issue"));
    }
    return payload.issue;
  });

  const issueLabelId = Effect.fn("linear.issueLabelId")(function* (
    ref: LinearTeamRef,
    issueId: string,
    label: string,
  ) {
    const data = yield* rawData(ref, issueLabelQuery, { id: issueId, label });
    const payload = yield* Effect.mapError(decodeIssueLabel(data), toUnavailable);
    if (payload.issue === null) return yield* unavailable(`Linear issue not found: ${issueId}`);
    return payload.issue.labels.nodes.at(0)?.id ?? null;
  });

  const issueAssignees = Effect.fn("linear.issueAssignees")(function* (ref: LinearTeamRef, issueId: string) {
    const data = yield* rawData(ref, issueAssigneesQuery, { id: issueId });
    const payload = yield* Effect.mapError(decodeIssueAssignees(data), toUnavailable);
    if (payload.issue === null) return yield* unavailable(`Linear issue not found: ${issueId}`);
    return payload.issue.assignee ? [payload.issue.assignee.id] : [];
  });

  const readIssueProse = (ref: LinearTeamRef, issueId: string, enforceAdmissionLimit: boolean) => {
    const loadPage = Effect.fn("linear.loadCommentPage")(function* (state: CommentPaginationState) {
      const data = yield* rawData(ref, commentsQuery, { id: issueId, after: state.after });
      const payload = yield* Effect.mapError(decodeComments(data), toUnavailable);
      if (!payload.issue) return yield* unavailable(`Linear issue not found: ${issueId}`);
      const next = yield* continuationCursor(payload.issue.comments.pageInfo, issueId, "comment");
      const cursorRepeated = Option.exists(next, (after) => state.seen.has(after));
      if (cursorRepeated) {
        return yield* unavailable(`Linear comment cursor did not advance: ${issueId}`);
      }
      const comments = payload.issue.comments.nodes.map(toRawProseComment);
      const commentCount = state.commentCount + comments.length;
      const proseBytes =
        state.proseBytes +
        comments.reduce((total, comment) => total + rawCommentBytes(comment), 0) +
        (state.after === null ? Buffer.byteLength(payload.issue.description ?? "") : 0);
      const withinAdmissionLimit =
        commentCount <= workContextCommentLimit && proseBytes <= workContextProseByteLimit;
      if (enforceAdmissionLimit && !withinAdmissionLimit) {
        return yield* new IssueTrackerError({
          reason: "unavailable",
          retryable: false,
          message: `Linear issue thread exceeds admission limits (${workContextCommentLimit} comments or ${workContextProseByteLimit} bytes)`,
        });
      }
      const nextState = Option.map(
        next,
        (after) =>
          ({
            after,
            seen: new Set([...state.seen, after]),
            commentCount,
            proseBytes,
          }) satisfies CommentPaginationState,
      );
      const page = {
        body: payload.issue.description ?? "",
        comments,
      } satisfies CommentPage;
      return [[page], nextState] satisfies readonly [
        ReadonlyArray<CommentPage>,
        Option.Option<CommentPaginationState>,
      ];
    });
    return withPaginationDeadline(
      "comment",
      Stream.paginate<CommentPaginationState, CommentPage, IssueTrackerError>(
        { after: null, seen: new Set(), commentCount: 0, proseBytes: 0 },
        loadPage,
      ).pipe(
        Stream.runCollect,
        Effect.map((pages) => {
          const collected = Array.from(pages);
          return {
            body: collected.at(0)?.body ?? "",
            comments: collected.flatMap((page) => page.comments),
          };
        }),
      ),
    );
  };

  const readProse = (ref: LinearTeamRef, issueId: string) => readIssueProse(ref, issueId, true);
  const readTriggerProse = (ref: LinearTeamRef, issueId: string) => readIssueProse(ref, issueId, false);

  return {
    authenticatedUserId: Effect.fn("linear.authenticatedUserId")(function* (ref: LinearTeamRef) {
      const credential = yield* credentialFor(ref);
      if (credential.identity) return credential.identity.actorUserId;
      return yield* callWithCredential(ref, credential, (sdk) => sdk.viewer.then((viewer) => viewer.id));
    }),
    observeIssues,
    observeOpenIssuesSince,
    observeLabelledIssues,
    issueAssignees,
    labelAppliedAt,
    listWorkflowStates: (ref: LinearTeamRef) =>
      Effect.map(loadTeam(ref, metaShape), (team): ReadonlyArray<RawWorkflowState> => team.states.nodes),
    listComments: Effect.fn("linear.listComments")(function* (
      ref: LinearTeamRef,
      issueId: string,
      coordination: CoordinationScope,
    ) {
      const data = yield* rawData(ref, coordinationCommentsQuery, {
        id: issueId,
        bot: coordination.actorUserId,
        ledger: coordination.ledgerMarker,
        proposal: coordination.proposalMarker,
      });
      const payload = yield* Effect.mapError(decodeCoordinationComments(data), toUnavailable);
      return [...(payload.issue?.comments.nodes ?? []), ...(payload.issue?.proposalComments.nodes ?? [])].map(
        toRawComment,
      );
    }),
    findMarker: Effect.fn("linear.findMarker")(function* (
      ref: LinearTeamRef,
      issueId: string,
      marker: string,
    ) {
      const data = yield* rawData(ref, issueMarkerQuery, { id: issueId, marker });
      const payload = yield* Effect.mapError(decodeIssueMarker(data), toUnavailable);
      if (!payload.issue) return yield* unavailable(`Linear issue not found: ${issueId}`);
      return {
        body: payload.issue.description?.includes(marker) ?? false,
        comment: payload.issue.comments.nodes.length > 0,
      };
    }),
    readActionIssue: Effect.fn("linear.readActionIssue")(function* (ref: LinearTeamRef, issueId: string) {
      const data = yield* rawData(ref, actionIssueQuery, { id: issueId });
      const payload = yield* Effect.mapError(decodeActionIssue(data), toUnavailable);
      if (!payload.issue) return yield* unavailable(`Linear issue not found: ${issueId}`);
      return toActionIssue(payload.issue);
    }),
    readTriggerIssue: Effect.fn("linear.readTriggerIssue")(function* (ref: LinearTeamRef, issueId: string) {
      const data = yield* rawData(ref, triggerIssueQuery, { id: issueId });
      const payload = yield* Effect.mapError(decodeTriggerIssue(data), toUnavailable);
      if (!payload.issue) return null;
      const issue: RawIssue = toRawIssue(payload.issue, yield* openBlockersOf(ref, payload.issue));
      return issue;
    }),
    findActionIssue: Effect.fn("linear.findActionIssue")(function* (ref: LinearTeamRef, marker: string) {
      const team = yield* loadTeam(ref, actionIssueMarkerShape, { marker });
      const issue = team.issues.nodes.at(0);
      return issue ? toActionIssue(issue) : null;
    }),
    readProse,
    createIssue,
    readTriggerProse,
    listLabels,
    addLabel: (ref: LinearTeamRef, issueId: string, label: string) =>
      Effect.gen(function* () {
        const labelId = yield* ensureLabel(ref, label);
        yield* mutate(ref, "issueAddLabel", (sdk) => sdk.issueAddLabel(issueId, labelId));
      }),
    removeLabel: (ref: LinearTeamRef, issueId: string, label: string) =>
      Effect.gen(function* () {
        const labelId = yield* issueLabelId(ref, issueId, label);
        if (labelId === null) return;
        yield* mutate(ref, "issueRemoveLabel", (sdk) => sdk.issueRemoveLabel(issueId, labelId));
      }),
    setState: (ref: LinearTeamRef, issueId: string, stateId: string) =>
      mutate(ref, "issueUpdate", (sdk) => sdk.updateIssue(issueId, { stateId })),
    createComment: (ref: LinearTeamRef, issueId: string, body: string) =>
      mutate(ref, "commentCreate", (sdk) => sdk.createComment({ issueId, body })),
    editComment: (ref: LinearTeamRef, commentId: string, body: string) =>
      mutate(ref, "commentUpdate", (sdk) => sdk.updateComment(commentId, { body })),
  };
});

export type LinearClientService = Effect.Success<ReturnType<typeof make>>;

export class LinearClient extends Context.Service<LinearClient, LinearClientService>()(
  "@cogwork/engine/linear/client/LinearClient",
) {}

export const layer = Layer.effect(LinearClient, Effect.flatMap(CredentialStore, make));
