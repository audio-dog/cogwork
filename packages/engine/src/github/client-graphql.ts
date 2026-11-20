import { GitHubIssueFieldId, TrimmedNonEmptyString } from "@cogwork/contracts";
import * as Schema from "effect/Schema";

import type { GitHubRepoRef, RawIssuePullReference } from "./client";

const GraphQlResponse = Schema.Struct({
  data: Schema.optional(Schema.Unknown),
  errors: Schema.optional(Schema.NullOr(Schema.Array(Schema.Struct({ message: Schema.String })))),
});
export type GraphQlPayload = typeof GraphQlResponse.Type;
export const decodeGraphQl = Schema.decodeUnknownEffect(GraphQlResponse);
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
export const decodeClosingReferences = Schema.decodeUnknownEffect(ClosingReferencesPayload);

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
export const decodeIssuePullReferences = Schema.decodeUnknownEffect(IssuePullReferencesPayload);

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
export const decodeIssueFieldValues = Schema.decodeUnknownEffect(IssueFieldValuesPayload);
export const decodeIssueFieldValuePages = Schema.decodeUnknownEffect(IssueFieldValuePagesPayload);

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

export const issueFieldValuePagesQuery = (count: number) => {
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

export const closingReferencesCursor = (payload: typeof ClosingReferencesPayload.Type) => {
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

export interface IssueFieldValueState {
  readonly nodeId: string;
  readonly number: number;
  readonly values: ReadonlyMap<GitHubIssueFieldId, string>;
  readonly cursor: string | null;
}

const issueFieldValueCursor = (pageInfo: typeof IssueFieldValuePageInfo.Type) =>
  pageInfo.hasNextPage ? pageInfo.endCursor : null;

export const issueFieldValueState = (
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

export const continuedIssueFieldValueState = (
  state: IssueFieldValueState,
  issue: typeof IssueFieldValueIssue.Type | null | undefined,
) => {
  if (!issue) return completedIssueFieldValueState(state);
  return issueFieldValueState(issue, state.values);
};

export const issueFieldValuePageVariables = (states: ReadonlyArray<IssueFieldValueState>) =>
  Object.fromEntries(
    states.flatMap((state, index) => [
      [`id${index}`, state.nodeId],
      [`cursor${index}`, state.cursor],
    ]),
  );

export const issueFieldValuesByIssue = (states: ReadonlyArray<IssueFieldValueState>) =>
  new Map(states.map((state) => [state.number, state.values] as const));
