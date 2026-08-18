import { type Priority, resolvePriority } from "@cogwork/contracts";
import * as Schema from "effect/Schema";

export const defaultPriorityField = "Priority";

// One page of a Projects v2 board read over GraphQL. Each item links to its content (we only care
// about issues) and carries the single-select value of the named priority field. Both are nullable:
// a card can point at a PR or draft, and the field can be unset — either way the item has no
// readable priority and resolves to the default.
const ItemNode = Schema.Struct({
  content: Schema.NullOr(
    Schema.Struct({
      number: Schema.optional(Schema.Finite),
    }),
  ),
  fieldValueByName: Schema.NullOr(
    Schema.Struct({
      name: Schema.optional(Schema.String),
    }),
  ),
});

const ProjectPrioritiesPayload = Schema.Struct({
  repositoryOwner: Schema.NullOr(
    Schema.Struct({
      projectV2: Schema.NullOr(
        Schema.Struct({
          items: Schema.Struct({
            pageInfo: Schema.Struct({
              hasNextPage: Schema.Boolean,
              endCursor: Schema.NullOr(Schema.String),
            }),
            nodes: Schema.Array(ItemNode),
          }),
        }),
      ),
    }),
  ),
});
export type ProjectPrioritiesPayload = typeof ProjectPrioritiesPayload.Type;

export const decodeProjectPriorities = Schema.decodeUnknownEffect(ProjectPrioritiesPayload);

export const priorityQuery = `
query ProjectPriorities($owner: String!, $number: Int!, $field: String!, $cursor: String) {
  repositoryOwner(login: $owner) {
    ... on ProjectV2Owner {
      projectV2(number: $number) {
        items(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            content { ... on Issue { number } }
            fieldValueByName(name: $field) {
              ... on ProjectV2ItemFieldSingleSelectValue { name }
            }
          }
        }
      }
    }
  }
}`;

export interface PriorityPage {
  readonly entries: ReadonlyArray<readonly [number, Priority]>;
  readonly nextCursor: string | null;
}

// Reduce one decoded page into issue-number → priority entries. Cards without an issue number are
// skipped; an unset or unknown field value resolves to the default priority.
export const pageOf = (payload: ProjectPrioritiesPayload): PriorityPage => {
  const items = payload.repositoryOwner?.projectV2?.items;
  if (!items) return { entries: [], nextCursor: null };
  const entries = items.nodes.flatMap((node): ReadonlyArray<readonly [number, Priority]> => {
    const number = node.content?.number;
    if (number === undefined) return [];
    const entry: readonly [number, Priority] = [number, resolvePriority(node.fieldValueByName?.name)];
    return [entry];
  });
  return {
    entries,
    nextCursor: items.pageInfo.hasNextPage ? items.pageInfo.endCursor : null,
  };
};
