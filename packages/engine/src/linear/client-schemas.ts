import * as Schema from "effect/Schema";
import type { RawComment } from "./client-issue-mapping";

export const CommentNode = Schema.Struct({
  id: Schema.String,
  body: Schema.String,
  createdAt: Schema.String,
  user: Schema.NullOr(Schema.Struct({ id: Schema.String })),
});

export const ProseCommentNode = Schema.Struct({
  id: Schema.String,
  body: Schema.String,
  createdAt: Schema.String,
  user: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      active: Schema.Boolean,
      guest: Schema.Boolean,
      app: Schema.Boolean,
      admin: Schema.Boolean,
    }),
  ),
});

export const RelationNode = Schema.Struct({
  type: Schema.String,
  issue: Schema.Struct({ state: Schema.Struct({ type: Schema.String }) }),
});

export const PageInfoNode = Schema.Struct({
  hasNextPage: Schema.Boolean,
  endCursor: Schema.NullOr(Schema.String),
});

const RelationConnection = Schema.Struct({
  nodes: Schema.Array(RelationNode),
  pageInfo: PageInfoNode,
});

export interface RelationPaginationState {
  readonly after: string;
  readonly seen: ReadonlySet<string>;
}

export interface CommentPaginationState {
  readonly after: string | null;
  readonly seen: ReadonlySet<string>;
  readonly commentCount: number;
  readonly proseBytes: number;
}

export interface CommentPage {
  readonly body: string;
  readonly comments: ReadonlyArray<RawComment>;
}

export const IssueNode = Schema.Struct({
  id: Schema.String,
  identifier: Schema.String,
  title: Schema.String,
  url: Schema.String,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  priority: Schema.optional(Schema.Finite),
  createdAt: Schema.optional(Schema.String),
  updatedAt: Schema.optional(Schema.String),
  labels: Schema.Struct({
    nodes: Schema.Array(Schema.Struct({ name: Schema.String })),
  }),
  assignee: Schema.optional(Schema.NullOr(Schema.Struct({ id: Schema.String }))),
  state: Schema.Struct({
    name: Schema.String,
    type: Schema.String,
  }),
  inverseRelations: Schema.optional(RelationConnection),
  comments: Schema.optional(Schema.Struct({ nodes: Schema.Array(CommentNode) })),
  proposalComments: Schema.optional(Schema.Struct({ nodes: Schema.Array(CommentNode) })),
});

const StateNode = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  type: Schema.String,
});

const LabelNode = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
});

export const IssuesTeamNode = Schema.Struct({
  issues: Schema.Struct({
    nodes: Schema.Array(IssueNode),
    pageInfo: PageInfoNode,
  }),
});

export const MetaTeamNode = Schema.Struct({
  id: Schema.String,
  states: Schema.Struct({ nodes: Schema.Array(StateNode) }),
});

export const LabelTeamNode = Schema.Struct({
  id: Schema.String,
  labels: Schema.Struct({ nodes: Schema.Array(LabelNode) }),
});

const WorkspaceLabelsPayload = Schema.Struct({
  issueLabels: Schema.Struct({ nodes: Schema.Array(LabelNode) }),
});

const CommentsPayload = Schema.Struct({
  issue: Schema.NullOr(
    Schema.Struct({
      description: Schema.NullOr(Schema.String),
      comments: Schema.Struct({
        nodes: Schema.Array(ProseCommentNode),
        pageInfo: PageInfoNode,
      }),
    }),
  ),
});

const CoordinationCommentsPayload = Schema.Struct({
  issue: Schema.NullOr(
    Schema.Struct({
      comments: Schema.Struct({ nodes: Schema.Array(CommentNode) }),
      proposalComments: Schema.Struct({ nodes: Schema.Array(CommentNode) }),
    }),
  ),
});

const IssueMarkerPayload = Schema.Struct({
  issue: Schema.NullOr(
    Schema.Struct({
      description: Schema.NullOr(Schema.String),
      comments: Schema.Struct({ nodes: Schema.Array(Schema.Struct({ id: Schema.String })) }),
    }),
  ),
});

export const ActionIssueNode = Schema.Struct({
  id: Schema.String,
  identifier: Schema.String,
  url: Schema.String,
  description: Schema.NullOr(Schema.String),
  labels: Schema.Struct({ nodes: Schema.Array(LabelNode) }),
  state: Schema.Struct({ type: Schema.String }),
});

const ActionIssuePayload = Schema.Struct({ issue: Schema.NullOr(ActionIssueNode) });
const TriggerIssuePayload = Schema.Struct({ issue: Schema.NullOr(IssueNode) });

export const ActionIssuesTeamNode = Schema.Struct({
  issues: Schema.Struct({ nodes: Schema.Array(ActionIssueNode) }),
});

const IssueRelationsPayload = Schema.Struct({
  issue: Schema.NullOr(Schema.Struct({ inverseRelations: RelationConnection })),
});

const IssueLabelPayload = Schema.Struct({
  issue: Schema.NullOr(Schema.Struct({ labels: Schema.Struct({ nodes: Schema.Array(LabelNode) }) })),
});

const IssueAssigneesPayload = Schema.Struct({
  issue: Schema.NullOr(
    Schema.Struct({ assignee: Schema.optional(Schema.NullOr(Schema.Struct({ id: Schema.String }))) }),
  ),
});

export const decodeComments = Schema.decodeUnknownEffect(CommentsPayload);
export const decodeCoordinationComments = Schema.decodeUnknownEffect(CoordinationCommentsPayload);
export const decodeIssueMarker = Schema.decodeUnknownEffect(IssueMarkerPayload);
export const decodeActionIssue = Schema.decodeUnknownEffect(ActionIssuePayload);
export const decodeTriggerIssue = Schema.decodeUnknownEffect(TriggerIssuePayload);
export const decodeWorkspaceLabels = Schema.decodeUnknownEffect(WorkspaceLabelsPayload);
export const decodeIssueRelations = Schema.decodeUnknownEffect(IssueRelationsPayload);
export const decodeIssueLabel = Schema.decodeUnknownEffect(IssueLabelPayload);
export const decodeIssueAssignees = Schema.decodeUnknownEffect(IssueAssigneesPayload);
