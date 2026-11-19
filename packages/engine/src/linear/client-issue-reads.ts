import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { IssueTrackerError } from "../issue-tracker";
import { toUnavailable, unavailable, withPaginationDeadline } from "./client-errors";
import {
  continuationCursor,
  countOpenBlockers,
  isOpenBlocker,
  millisFromIso,
  toObservedIssue,
} from "./client-issue-mapping";
import {
  coordinatedIssuesShape,
  decodeHistory,
  issueHistoryQuery,
  issueRelationsQuery,
  issuesShape,
  openIssuesFilter,
  type TeamShape,
  teamIdPattern,
  uncompletedIssuesFilter,
} from "./client-queries";
import {
  decodeIssueRelations,
  type IssueNode,
  type IssuesTeamNode,
  type RelationNode,
  type RelationPaginationState,
} from "./client-schemas";
import type { LinearTeamRef, LinearTransport } from "./client-transport";

export interface CoordinationScope {
  readonly actorUserId: string;
  readonly ledgerMarker: string;
  readonly proposalMarker: string;
}

export const makeIssueReads = ({ rawData }: LinearTransport) => {
  const loadRelationPage = Effect.fn("linear.loadRelationPage")(function* (
    ref: LinearTeamRef,
    issueId: string,
    after: string,
  ) {
    const data = yield* rawData(ref, issueRelationsQuery, { id: issueId, after });
    const payload = yield* Effect.mapError(decodeIssueRelations(data), toUnavailable);
    if (!payload.issue) return yield* unavailable(`Linear issue not found: ${issueId}`);
    return payload.issue.inverseRelations;
  });

  const continueRelations = Effect.fn("linear.continueRelations")(function* (
    ref: LinearTeamRef,
    issue: typeof IssueNode.Type,
    cursor: RelationPaginationState,
  ) {
    const page = yield* loadRelationPage(ref, issue.id, cursor.after);
    const next = yield* continuationCursor(page.pageInfo, issue.identifier);
    const cursorRepeated = Option.exists(next, (after) => cursor.seen.has(after));
    if (cursorRepeated) {
      return yield* unavailable(`Linear relation cursor did not advance: ${issue.identifier}`);
    }
    const nextCursor = Option.map(
      next,
      (after) =>
        ({
          after,
          seen: new Set([...cursor.seen, after]),
        }) satisfies RelationPaginationState,
    );
    return [page.nodes, nextCursor] satisfies readonly [
      ReadonlyArray<typeof RelationNode.Type>,
      Option.Option<RelationPaginationState>,
    ];
  });

  const openBlockersOf = Effect.fn("linear.openBlockersOf")(function* (
    ref: LinearTeamRef,
    issue: typeof IssueNode.Type,
  ) {
    const firstPage = issue.inverseRelations;
    if (!firstPage) return 0;
    const firstCursor = yield* continuationCursor(firstPage.pageInfo, issue.identifier);
    const initialCursor = Option.map(
      firstCursor,
      (after) => ({ after, seen: new Set([after]) }) satisfies RelationPaginationState,
    );
    const remaining = yield* withPaginationDeadline(
      "relation",
      Stream.fromIterable(Option.toArray(initialCursor)).pipe(
        Stream.flatMap((cursor) =>
          Stream.paginate<RelationPaginationState, typeof RelationNode.Type, IssueTrackerError>(
            cursor,
            (current) => continueRelations(ref, issue, current),
          ),
        ),
        Stream.filter(isOpenBlocker),
        Stream.runCount,
      ),
    );
    return countOpenBlockers(firstPage.nodes) + remaining;
  });

  const loadTeam = <A>(
    ref: LinearTeamRef,
    shape: TeamShape<A>,
    extraVariables: Record<string, unknown> = {},
  ) =>
    Effect.gen(function* () {
      const route = teamIdPattern.test(ref.team) ? shape.byId : shape.byKey;
      const data = yield* rawData(ref, route.document, {
        ...route.variables(ref.team),
        ...extraVariables,
      });
      const team = yield* route.decode(data);
      if (!team) {
        return yield* unavailable(`Linear team not found: ${ref.team}`);
      }
      return team;
    });

  const observeIssues = Effect.fn("linear.observeIssues")(function* (
    ref: LinearTeamRef,
    coordination: CoordinationScope | null,
  ) {
    return yield* observeMatching(ref, coordination, uncompletedIssuesFilter);
  });

  const observeOpenIssuesSince = Effect.fn("linear.observeOpenIssuesSince")(function* (
    ref: LinearTeamRef,
    updatedSince: number,
    assigneeIds: ReadonlyArray<string> | undefined,
  ) {
    return yield* observeMatching(ref, null, {
      ...openIssuesFilter(assigneeIds),
      updatedAt: { gte: DateTime.formatIso(DateTime.makeUnsafe(updatedSince)) },
    });
  });

  const observeLabelledIssues = Effect.fn("linear.observeLabelledIssues")(function* (
    ref: LinearTeamRef,
    label: string,
    assigneeIds: ReadonlyArray<string> | undefined,
  ) {
    return yield* observeMatching(ref, null, {
      ...openIssuesFilter(assigneeIds),
      labels: { name: { eq: label } },
    });
  });

  const observeMatching = Effect.fn("linear.observeMatching")(function* (
    ref: LinearTeamRef,
    coordination: CoordinationScope | null,
    filter: Record<string, unknown>,
  ) {
    const shape = coordination ? coordinatedIssuesShape : issuesShape;
    const scopeVariables = coordination
      ? {
          bot: coordination.actorUserId,
          ledger: coordination.ledgerMarker,
          proposal: coordination.proposalMarker,
        }
      : {};
    const loadPage = (after: string | null) => loadTeam(ref, shape, { ...scopeVariables, filter, after });
    const issues = yield* Stream.paginate<string | null, typeof IssueNode.Type, IssueTrackerError>(
      null,
      (after) =>
        Effect.gen(function* () {
          const team: typeof IssuesTeamNode.Type = yield* loadPage(after);
          const page = team.issues.pageInfo;
          const next: Option.Option<string> = page.hasNextPage
            ? Option.fromNullOr(page.endCursor)
            : Option.none();
          return [team.issues.nodes, next] satisfies readonly [
            ReadonlyArray<typeof IssueNode.Type>,
            Option.Option<string>,
          ];
        }),
    ).pipe(Stream.runCollect);
    return yield* Effect.forEach(issues, (issue) =>
      Effect.map(openBlockersOf(ref, issue), (openBlockers) => toObservedIssue(issue, openBlockers)),
    );
  });

  const labelAppliedAt = Effect.fn("linear.labelAppliedAt")(function* (
    ref: LinearTeamRef,
    issueId: string,
    label: string,
  ) {
    const collect: (after?: string | null) => Effect.Effect<ReadonlyArray<number>, IssueTrackerError> =
      Effect.fn("linear.collectLabelHistory")(function* (after = null) {
        const data = yield* rawData(ref, issueHistoryQuery, { id: issueId, after });
        const payload = yield* Effect.mapError(decodeHistory(data), toUnavailable);
        const history = payload.issue?.history;
        if (!history) return [];
        const current = history.nodes.flatMap((entry) =>
          entry.addedLabels?.some(({ name }) => name === label) ? [millisFromIso(entry.createdAt)] : [],
        );
        if (!history.pageInfo.hasNextPage) return current;
        const cursor = history.pageInfo.endCursor;
        if (cursor === null)
          return yield* unavailable(`Linear label history page missing cursor: ${issueId}`);
        return [...current, ...(yield* collect(cursor))];
      });
    const applied = yield* withPaginationDeadline("label history", collect());
    return applied.at(-1) ?? null;
  });

  return {
    openBlockersOf,
    loadTeam,
    observeIssues,
    observeOpenIssuesSince,
    observeLabelledIssues,
    labelAppliedAt,
  };
};
