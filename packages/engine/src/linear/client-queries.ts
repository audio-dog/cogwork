import type { IssueLabelConnection } from "@linear/sdk";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { IssueTrackerError } from "../issue-tracker";
import { toUnavailable } from "./client-errors";
import {
  ActionIssuesTeamNode,
  IssuesTeamNode,
  LabelTeamNode,
  MetaTeamNode,
  PageInfoNode,
} from "./client-schemas";

export const teamIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const issuePageSize = 100;
const labelPageSize = 50;
export const workContextCommentLimit = 10_000;
export const workContextProseByteLimit = 16 * 1024 * 1024;
// Linear rejects any single query above 10,000 complexity points, and a nested connection multiplies
// its children by its page size, so these sizes multiply out rather than add up.
const relationPageSize = 7;
const continuedRelationPageSize = 100;
const coordinationPageSize = 5;

const relationFields = `
        nodes { type issue { state { type } } }
        pageInfo { hasNextPage endCursor }`;

const issueFields = `
      id
      identifier
      title
      url
      description
      priority
      createdAt
      updatedAt
      labels(first: ${labelPageSize}) { nodes { name } }
      assignee { id }
      state { name type }
      inverseRelations(first: ${relationPageSize}) {${relationFields}
      }`;

const coordinationFields = `
      comments(
        filter: { user: { id: { eq: $bot } }, body: { contains: $ledger } }
        orderBy: createdAt
        first: ${coordinationPageSize}
      ) {
        nodes { id body createdAt user { id } }
      }
      # last: 1 is deliberate — the proposal attribution is unique to proposal notes, so the
      # newest match is the current proposal, and fetching more would break the per-query complexity cap.
      proposalComments: comments(
        filter: { user: { id: { eq: $bot } }, body: { contains: $proposal } }
        orderBy: createdAt
        last: 1
      ) {
        nodes { id body createdAt user { id } }
      }`;

const issuesSelection = (coordination: string) => `
  issues(filter: $filter, first: ${issuePageSize}, after: $after) {
    nodes {${issueFields}${coordination}
    }
    pageInfo { hasNextPage endCursor }
  }`;

const issuesArgs = ", $filter: IssueFilter, $after: String";

const resolvedStateTypes: ReadonlyArray<string> = ["completed", "canceled"];

export const uncompletedIssuesFilter = { state: { type: { nin: ["completed"] } } };

// The allowlist narrows the read only to save Linear complexity. The assignee gate in Trigger
// observation stays the authority (ADR 0008).
export const openIssuesFilter = (assigneeIds: ReadonlyArray<string> | undefined) => ({
  state: { type: { nin: resolvedStateTypes } },
  ...(assigneeIds === undefined ? {} : { assignee: { id: { in: assigneeIds } } }),
});

const metaSelection = `
  id
  states { nodes { id name type } }`;

// Linear caps an unpaginated connection at 50, and a team can hold more labels than that.
const labelSelection = `
  id
  labels(filter: { name: { eq: $label } }, first: 1) { nodes { id name } }`;

export const labelNames = (connection: IssueLabelConnection): Promise<ReadonlyArray<string>> =>
  connection.pageInfo.hasNextPage
    ? connection.fetchNext().then(labelNames)
    : Promise.resolve(connection.nodes.map(({ name }) => name));

// A workspace-level label belongs to no team, so no team-scoped connection lists it.
export const workspaceLabelQuery = `
query WorkspaceLabelByName($label: String!) {
  issueLabels(filter: { name: { eq: $label }, team: { null: true } }, first: 1) {
    nodes { id name }
  }
}`;

export const issueLabelQuery = `
query IssueLabelByName($id: String!, $label: String!) {
  issue(id: $id) {
    labels(filter: { name: { eq: $label } }, first: 1) { nodes { id name } }
  }
}`;

export const issueAssigneesQuery = `
query IssueAssignees($id: String!) {
  issue(id: $id) { assignee { id } }
}`;

export const commentsQuery = `
query IssueComments($id: String!, $after: String) {
  issue(id: $id) {
    description
    comments(first: 100, after: $after, orderBy: createdAt) {
      nodes {
        id
        body
        createdAt
        user { id active guest app admin }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

export const issueHistoryQuery = `
query IssueHistory($id: String!, $after: String) {
  issue(id: $id) {
    history(first: 250, after: $after, orderBy: createdAt) {
      nodes { createdAt addedLabels { name } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const HistoryPayload = Schema.Struct({
  issue: Schema.NullOr(
    Schema.Struct({
      history: Schema.Struct({
        nodes: Schema.Array(
          Schema.Struct({
            createdAt: Schema.String,
            addedLabels: Schema.optional(Schema.NullOr(Schema.Array(Schema.Struct({ name: Schema.String })))),
          }),
        ),
        pageInfo: PageInfoNode,
      }),
    }),
  ),
});
export const decodeHistory = Schema.decodeUnknownEffect(HistoryPayload);

export const activeUsersQuery = `
query ActiveUsers($after: String) {
  users(first: 250, after: $after, filter: { active: { eq: true } }) {
    nodes { id name displayName }
    pageInfo { hasNextPage endCursor }
  }
}`;

const ActiveUsersPayload = Schema.Struct({
  users: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({ id: Schema.String, name: Schema.String, displayName: Schema.String }),
    ),
    pageInfo: PageInfoNode,
  }),
});
export const decodeActiveUsers = Schema.decodeUnknownEffect(ActiveUsersPayload);

export type LinearUser = (typeof ActiveUsersPayload.Type)["users"]["nodes"][number];

export const coordinationCommentsQuery = `
query IssueCoordinationComments($id: String!, $bot: ID!, $ledger: String!, $proposal: String!) {
  issue(id: $id) {${coordinationFields}
  }
}`;

export const issueMarkerQuery = `
query IssueMarker($id: String!, $marker: String!) {
  issue(id: $id) {
    description
    comments(filter: { body: { contains: $marker } }, first: 1) { nodes { id } }
  }
}`;

const actionIssueSelection = `
      id
      identifier
      url
      description
      labels(first: ${labelPageSize}) { nodes { id name } }
      state { type }`;

export const actionIssueQuery = `
query ActionIssue($id: String!) {
  issue(id: $id) {${actionIssueSelection}
  }
}`;

export const triggerIssueQuery = `
query TriggerIssue($id: String!) {
  issue(id: $id) {${issueFields}
  }
}`;

export const issueRelationsQuery = `
query IssueInverseRelations($id: String!, $after: String) {
  issue(id: $id) {
    inverseRelations(first: ${continuedRelationPageSize}, after: $after) {${relationFields}
    }
  }
}`;

interface TeamAddressing<A> {
  readonly document: string;
  readonly variables: (team: string) => Record<string, unknown>;
  readonly decode: (data: unknown) => Effect.Effect<A | null, IssueTrackerError>;
}

export interface TeamShape<A> {
  readonly byId: TeamAddressing<A>;
  readonly byKey: TeamAddressing<A>;
}

const teamShape = <S extends Schema.Top & { readonly DecodingServices: never }>(
  node: S,
  selection: string,
  extraArgs = "",
): TeamShape<S["Type"]> => {
  const decodeById = Schema.decodeUnknownEffect(Schema.Struct({ team: Schema.NullOr(node) }));
  const decodeByKey = Schema.decodeUnknownEffect(
    Schema.Struct({ teams: Schema.Struct({ nodes: Schema.Array(node) }) }),
  );
  return {
    byId: {
      document: `query TeamById($id: String!${extraArgs}) {\n  team(id: $id) {${selection}\n  }\n}`,
      variables: (team) => ({ id: team }),
      decode: (data) =>
        Effect.map(Effect.mapError(decodeById(data), toUnavailable), (payload) => payload.team),
    },
    byKey: {
      document: `query TeamsByKey($key: String!${extraArgs}) {\n  teams(filter: { key: { eq: $key } }, first: 1) {\n    nodes {${selection}\n    }\n  }\n}`,
      variables: (team) => ({ key: team }),
      decode: (data) =>
        Effect.map(
          Effect.mapError(decodeByKey(data), toUnavailable),
          (payload) => payload.teams.nodes[0] ?? null,
        ),
    },
  };
};

export const metaShape = teamShape(MetaTeamNode, metaSelection);
export const labelShape = teamShape(LabelTeamNode, labelSelection, ", $label: String!");
export const issuesShape = teamShape(IssuesTeamNode, issuesSelection(""), issuesArgs);
export const coordinatedIssuesShape = teamShape(
  IssuesTeamNode,
  issuesSelection(coordinationFields),
  `${issuesArgs}, $bot: ID!, $ledger: String!, $proposal: String!`,
);
export const actionIssueMarkerShape = teamShape(
  ActionIssuesTeamNode,
  `
  issues(filter: { description: { contains: $marker } }, first: 1) {
    nodes {${actionIssueSelection}
    }
  }`,
  ", $marker: String!",
);

export const isResolvedState = (stateType: string) => resolvedStateTypes.includes(stateType);
