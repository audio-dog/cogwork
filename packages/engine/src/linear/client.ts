import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { WorkSourceError } from "../WorkSource";

export interface LinearTeamRef {
  readonly team: string;
  readonly tokenEnv: string;
}

export interface RawIssue {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly labels: ReadonlyArray<string>;
  readonly stateName: string;
  readonly stateType: string;
}

export interface RawComment {
  readonly id: string;
  readonly authorId: string;
  readonly authorName: string;
  readonly body: string;
  readonly createdAtMillis: number;
}

export interface RawWorkflowState {
  readonly id: string;
  readonly name: string;
  readonly type: string;
}

export interface RawLabel {
  readonly id: string;
  readonly name: string;
}

const graphqlUrl = "https://api.linear.app/graphql";

const IssueNode = Schema.Struct({
  id: Schema.String,
  identifier: Schema.String,
  title: Schema.String,
  labels: Schema.Struct({
    nodes: Schema.Array(Schema.Struct({ name: Schema.String })),
  }),
  state: Schema.Struct({
    name: Schema.String,
    type: Schema.String,
  }),
});

const CommentNode = Schema.Struct({
  id: Schema.String,
  body: Schema.String,
  createdAt: Schema.String,
  user: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
  }),
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

const teamFields = {
  id: Schema.String,
  issues: Schema.Struct({ nodes: Schema.Array(IssueNode) }),
  states: Schema.Struct({ nodes: Schema.Array(StateNode) }),
  labels: Schema.Struct({ nodes: Schema.Array(LabelNode) }),
} as const;

const TeamPayload = Schema.Struct({
  team: Schema.NullOr(Schema.Struct(teamFields)),
});

const TeamsPayload = Schema.Struct({
  teams: Schema.Struct({
    nodes: Schema.Array(Schema.Struct({ ...teamFields, key: Schema.String })),
  }),
});

const CommentsPayload = Schema.Struct({
  issue: Schema.NullOr(
    Schema.Struct({
      comments: Schema.Struct({ nodes: Schema.Array(CommentNode) }),
    }),
  ),
});

const GraphqlEnvelope = Schema.Struct({
  data: Schema.optional(Schema.Unknown),
  errors: Schema.optional(
    Schema.Array(
      Schema.Struct({
        message: Schema.String,
        extensions: Schema.optional(
          Schema.Struct({
            code: Schema.optional(Schema.String),
          }),
        ),
      }),
    ),
  ),
});

const MutationOk = Schema.Struct({
  success: Schema.optional(Schema.Boolean),
});

const CommentCreatePayload = Schema.Struct({
  commentCreate: Schema.Struct({
    success: Schema.Boolean,
    comment: Schema.Struct({ id: Schema.String }),
  }),
});

const LabelCreatePayload = Schema.Struct({
  issueLabelCreate: Schema.Struct({
    success: Schema.Boolean,
    issueLabel: Schema.Struct({ id: Schema.String }),
  }),
});

const decodeEnvelope = Schema.decodeUnknownEffect(GraphqlEnvelope);
const decodeTeam = Schema.decodeUnknownEffect(TeamPayload);
const decodeTeams = Schema.decodeUnknownEffect(TeamsPayload);
const decodeComments = Schema.decodeUnknownEffect(CommentsPayload);
const decodeCommentCreate = Schema.decodeUnknownEffect(CommentCreatePayload);
const decodeLabelCreate = Schema.decodeUnknownEffect(LabelCreatePayload);
const decodeMutation = Schema.decodeUnknownEffect(MutationOk);

const firstObject = (data: unknown) => {
  if (data === null || typeof data !== "object") return data;
  const values = Object.values(data);
  return values.length === 1 ? values[0] : data;
};

const unavailable = (message: string) => new WorkSourceError({ reason: "unavailable", message });
const toUnavailable = (error: { readonly message: string }) => unavailable(error.message);

const millisFromIso = (value: string) => {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
};

const teamSelection = `
  id
  issues(filter: { state: { type: { nin: ["completed"] } } }, first: 100) {
    nodes {
      id
      identifier
      title
      labels { nodes { name } }
      state { name type }
    }
  }
  states { nodes { id name type } }
  labels { nodes { id name } }
`;

const teamByIdQuery = `
query TeamById($id: String!) {
  team(id: $id) {
    ${teamSelection}
  }
}`;

const teamsByKeyQuery = `
query TeamsByKey($key: String!) {
  teams(filter: { key: { eq: $key } }, first: 1) {
    nodes {
      key
      ${teamSelection}
    }
  }
}`;

const commentsQuery = `
query IssueComments($id: String!) {
  issue(id: $id) {
    comments(first: 100) {
      nodes {
        id
        body
        createdAt
        user { id name }
      }
    }
  }
}`;

const toRawIssue = (issue: typeof IssueNode.Type): RawIssue => ({
  id: issue.id,
  identifier: issue.identifier,
  title: issue.title,
  labels: issue.labels.nodes.map((label) => label.name),
  stateName: issue.state.name,
  stateType: issue.state.type,
});

type TeamBundle = {
  readonly id: string;
  readonly issues: { readonly nodes: ReadonlyArray<typeof IssueNode.Type> };
  readonly states: { readonly nodes: ReadonlyArray<typeof StateNode.Type> };
  readonly labels: { readonly nodes: ReadonlyArray<typeof LabelNode.Type> };
};

const packTeam = (team: TeamBundle) => ({
  id: team.id,
  issues: team.issues.nodes.map(toRawIssue),
  states: team.states.nodes,
  labels: team.labels.nodes,
});

const make = (client: HttpClient.HttpClient) => {
  const send = Effect.fn("linear.send")(function* (ref: LinearTeamRef, query: string, variables: unknown) {
    const token = yield* Effect.mapError(
      Config.redacted(ref.tokenEnv),
      () => new WorkSourceError({ reason: "auth", message: `missing Linear token in ${ref.tokenEnv}` }),
    );
    const request = yield* Effect.mapError(
      HttpClientRequest.bodyJson(HttpClientRequest.post(graphqlUrl), { query, variables }),
      toUnavailable,
    );
    const response = yield* Effect.catchTag(
      client.execute(
        request.pipe(
          HttpClientRequest.setHeader("Authorization", Redacted.value(token)),
          HttpClientRequest.setHeader("Content-Type", "application/json"),
        ),
      ),
      "HttpClientError",
      (error) => Effect.fail(unavailable(error.message)),
    );
    if (response.status === 401 || response.status === 403) {
      return yield* new WorkSourceError({ reason: "auth", message: "Linear authentication failed" });
    }
    if (response.status >= 400) {
      return yield* unavailable(`Linear request failed (${response.status})`);
    }
    const json = yield* Effect.mapError(response.json, toUnavailable);
    const envelope = yield* Effect.mapError(decodeEnvelope(json), toUnavailable);
    if (envelope.errors && envelope.errors.length > 0) {
      const authError = envelope.errors.find(
        (error) => error.extensions?.code === "AUTHENTICATION_ERROR" || /auth/i.test(error.message),
      );
      return yield* authError
        ? new WorkSourceError({ reason: "auth", message: authError.message })
        : unavailable(envelope.errors.map((error) => error.message).join("; "));
    }
    if (envelope.data === undefined) {
      return yield* unavailable("Linear response missing data");
    }
    return envelope.data;
  });

  const mutate = Effect.fn("linear.mutate")(function* (
    ref: LinearTeamRef,
    query: string,
    variables: unknown,
  ) {
    const data = yield* send(ref, query, variables);
    const result = yield* Effect.mapError(decodeMutation(firstObject(data)), toUnavailable);
    if (result.success === false) {
      return yield* unavailable("Linear mutation failed");
    }
    return yield* Effect.void;
  });

  const loadTeam = Effect.fn("linear.loadTeam")(function* (ref: LinearTeamRef) {
    const byId = yield* send(ref, teamByIdQuery, { id: ref.team });
    const teamPayload = yield* Effect.mapError(decodeTeam(byId), toUnavailable);
    if (teamPayload.team) {
      return packTeam(teamPayload.team);
    }
    const byKey = yield* send(ref, teamsByKeyQuery, { key: ref.team });
    const teamsPayload = yield* Effect.mapError(decodeTeams(byKey), toUnavailable);
    const team = teamsPayload.teams.nodes[0];
    if (!team) {
      return yield* unavailable(`Linear team not found: ${ref.team}`);
    }
    return packTeam(team);
  });

  const ensureLabel = Effect.fn("linear.ensureLabel")(function* (ref: LinearTeamRef, name: string) {
    const team = yield* loadTeam(ref);
    const existing = team.labels.find((label) => label.name === name);
    if (existing) return existing.id;
    const data = yield* send(
      ref,
      `
      mutation CreateLabel($teamId: String!, $name: String!) {
        issueLabelCreate(input: { teamId: $teamId, name: $name }) {
          success
          issueLabel { id name }
        }
      }
    `,
      { teamId: team.id, name },
    );
    const created = yield* Effect.mapError(decodeLabelCreate(data), toUnavailable);
    if (created.issueLabelCreate.success === false) {
      return yield* unavailable("Linear issueLabelCreate failed");
    }
    return created.issueLabelCreate.issueLabel.id;
  });

  return {
    listIssues: (ref: LinearTeamRef) => Effect.map(loadTeam(ref), (team) => team.issues),
    listWorkflowStates: (ref: LinearTeamRef) =>
      Effect.map(loadTeam(ref), (team): ReadonlyArray<RawWorkflowState> => team.states),
    listComments: (ref: LinearTeamRef, issueId: string) =>
      Effect.gen(function* () {
        const data = yield* send(ref, commentsQuery, { id: issueId });
        const payload = yield* Effect.mapError(decodeComments(data), toUnavailable);
        return (payload.issue?.comments.nodes ?? []).map(
          (comment): RawComment => ({
            id: comment.id,
            authorId: comment.user.id,
            authorName: comment.user.name,
            body: comment.body,
            createdAtMillis: millisFromIso(comment.createdAt),
          }),
        );
      }),
    addLabel: (ref: LinearTeamRef, issueId: string, label: string) =>
      Effect.gen(function* () {
        const labelId = yield* ensureLabel(ref, label);
        yield* mutate(
          ref,
          `
          mutation AddLabel($issueId: String!, $labelId: String!) {
            issueAddLabel(id: $issueId, labelId: $labelId) { success }
          }
        `,
          { issueId, labelId },
        );
      }),
    removeLabel: (ref: LinearTeamRef, issueId: string, label: string) =>
      Effect.gen(function* () {
        const team = yield* loadTeam(ref);
        const found = team.labels.find((entry) => entry.name === label);
        if (!found) return;
        yield* mutate(
          ref,
          `
          mutation RemoveLabel($issueId: String!, $labelId: String!) {
            issueRemoveLabel(id: $issueId, labelId: $labelId) { success }
          }
        `,
          { issueId, labelId: found.id },
        );
      }),
    setState: (ref: LinearTeamRef, issueId: string, stateId: string) =>
      mutate(
        ref,
        `
        mutation SetState($issueId: String!, $stateId: String!) {
          issueUpdate(id: $issueId, input: { stateId: $stateId }) { success }
        }
      `,
        { issueId, stateId },
      ),
    createComment: (ref: LinearTeamRef, issueId: string, body: string) =>
      Effect.gen(function* () {
        const data = yield* send(
          ref,
          `
          mutation CreateComment($issueId: String!, $body: String!) {
            commentCreate(input: { issueId: $issueId, body: $body }) {
              success
              comment { id }
            }
          }
        `,
          { issueId, body },
        );
        const created = yield* Effect.mapError(decodeCommentCreate(data), toUnavailable);
        if (created.commentCreate.success === false) {
          return yield* unavailable("Linear commentCreate failed");
        }
        return created.commentCreate.comment.id;
      }),
    editComment: (ref: LinearTeamRef, commentId: string, body: string) =>
      mutate(
        ref,
        `
        mutation EditComment($id: String!, $body: String!) {
          commentUpdate(id: $id, input: { body: $body }) { success }
        }
      `,
        { id: commentId, body },
      ),
  };
};

export type LinearClientService = ReturnType<typeof make>;

export class LinearClient extends Context.Service<LinearClient, LinearClientService>()(
  "@clanker-forge/engine/linear/client/LinearClient",
) {}

export const layer = Layer.effect(
  LinearClient,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return make(client);
  }),
);
