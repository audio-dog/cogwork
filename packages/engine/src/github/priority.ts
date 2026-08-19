import { type Priority, resolvePriority } from "@cogwork/contracts";
import * as Schema from "effect/Schema";

export const defaultPriorityField = "Priority";

const ItemNode = Schema.Struct({
  content: Schema.NullOr(
    Schema.Struct({
      number: Schema.optional(Schema.Finite),
      repository: Schema.optional(
        Schema.Struct({
          name: Schema.optional(Schema.String),
          owner: Schema.optional(
            Schema.Struct({
              login: Schema.optional(Schema.String),
            }),
          ),
        }),
      ),
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
            nodes: Schema.Array(Schema.NullOr(ItemNode)),
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
            content {
              ... on Issue {
                number
                repository { name owner { login } }
              }
            }
            fieldValueByName(name: $field) {
              ... on ProjectV2ItemFieldSingleSelectValue { name }
            }
          }
        }
      }
    }
  }
}`;

export interface PriorityRepo {
  readonly owner: string;
  readonly name: string;
}

export interface PriorityPage {
  readonly entries: ReadonlyArray<readonly [number, Priority]>;
  readonly nextCursor: string | null;
}

const matchesRepo = (repo: PriorityRepo, owner: string | undefined, name: string | undefined): boolean =>
  owner?.toLowerCase() === repo.owner.toLowerCase() && name?.toLowerCase() === repo.name.toLowerCase();

// Board cards can span repos and issue numbers collide across them.
export const pageOf = (payload: ProjectPrioritiesPayload, repo: PriorityRepo): PriorityPage => {
  const items = payload.repositoryOwner?.projectV2?.items;
  if (!items) return { entries: [], nextCursor: null };
  const entries = items.nodes.flatMap((node): ReadonlyArray<readonly [number, Priority]> => {
    if (node === null) return [];
    const content = node.content;
    const number = content?.number;
    if (number === undefined || content === null) return [];
    if (!matchesRepo(repo, content.repository?.owner?.login, content.repository?.name)) return [];
    const entry: readonly [number, Priority] = [number, resolvePriority(node.fieldValueByName?.name)];
    return [entry];
  });
  return {
    entries,
    nextCursor: items.pageInfo.hasNextPage ? items.pageInfo.endCursor : null,
  };
};
