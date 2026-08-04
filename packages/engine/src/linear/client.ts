import { LinearError, LinearClient as LinearSdk, RatelimitedLinearError } from "@linear/sdk";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { type Credential, CredentialStore, type CredentialStoreService } from "../CredentialStore";
import { WorkSourceError } from "../WorkSource";

export interface LinearTeamRef {
  readonly team: string;
  readonly tokenEnv: string;
  readonly organization: string | null;
  readonly clientId: string | null;
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
  user: Schema.NullOr(Schema.Struct({ id: Schema.String })),
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

const decodeTeam = Schema.decodeUnknownEffect(TeamPayload);
const decodeTeams = Schema.decodeUnknownEffect(TeamsPayload);
const decodeComments = Schema.decodeUnknownEffect(CommentsPayload);

const unavailable = (message: string) => new WorkSourceError({ reason: "unavailable", message });
const toUnavailable = (error: { readonly message: string }) => unavailable(error.message);

const isAuthStatus = (status: number | undefined) => status === 401 || status === 403;

const reasonFor = (cause: unknown): WorkSourceError["reason"] => {
  if (cause instanceof RatelimitedLinearError) return "rate-limited";
  if (cause instanceof LinearError && isAuthStatus(cause.status)) return "auth";
  return "unavailable";
};

const fromSdkError = (cause: unknown) =>
  new WorkSourceError({
    reason: reasonFor(cause),
    message: cause instanceof Error ? cause.message : String(cause),
  });

const attempt = <A>(run: () => PromiseLike<A>) => Effect.tryPromise({ try: run, catch: fromSdkError });

const teamIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
        user { id }
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

const toRawComment = (comment: typeof CommentNode.Type): ReadonlyArray<RawComment> =>
  comment.user
    ? [
        {
          id: comment.id,
          authorId: comment.user.id,
          body: comment.body,
          createdAtMillis: millisFromIso(comment.createdAt),
        },
      ]
    : [];

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

const requireSuccess = (operation: string, payload: { readonly success: boolean }) =>
  payload.success ? Effect.void : Effect.fail(unavailable(`Linear ${operation} failed`));

// A Linear API key authenticates as itself; an OAuth token is a bearer credential and has to reach
// the SDK as `accessToken` or it is sent without the `Bearer` prefix.
const sdkAuth = (credential: Credential) =>
  credential.source === "stored-oauth"
    ? { accessToken: Redacted.value(credential.token) }
    : { apiKey: Redacted.value(credential.token) };

const make = (credentials: CredentialStoreService) => {
  const sdkFor = Effect.fn("linear.sdk")(function* (ref: LinearTeamRef) {
    const credential = yield* Effect.mapError(
      credentials.bearerToken({
        key: ref.team,
        workSource: "linear",
        organization: ref.organization,
        tokenEnv: ref.tokenEnv,
        clientId: ref.clientId,
      }),
      (error) => new WorkSourceError({ reason: "auth", message: error.message }),
    );
    return new LinearSdk(sdkAuth(credential));
  });

  const call = <A>(ref: LinearTeamRef, run: (sdk: LinearSdk) => PromiseLike<A>) =>
    Effect.flatMap(sdkFor(ref), (sdk) => attempt(() => run(sdk)));

  // The SDK fetches nested models lazily, so typed reads cost two extra requests per issue; observe
  // only stays inside Linear's rate limit while these reads stay single documents.
  const rawData = Effect.fn("linear.rawRequest")(function* (
    ref: LinearTeamRef,
    document: string,
    variables: Record<string, unknown>,
  ) {
    const response = yield* call(ref, (sdk) =>
      sdk.client.rawRequest<unknown, Record<string, unknown>>(document, variables),
    );
    if (response.data === undefined) {
      return yield* unavailable("Linear response missing data");
    }
    return response.data;
  });

  const teamById = Effect.fn("linear.teamById")(function* (ref: LinearTeamRef) {
    const data = yield* rawData(ref, teamByIdQuery, { id: ref.team });
    const payload = yield* Effect.mapError(decodeTeam(data), toUnavailable);
    return payload.team;
  });

  const teamByKey = Effect.fn("linear.teamByKey")(function* (ref: LinearTeamRef) {
    const data = yield* rawData(ref, teamsByKeyQuery, { key: ref.team });
    const payload = yield* Effect.mapError(decodeTeams(data), toUnavailable);
    return payload.teams.nodes[0] ?? null;
  });

  const lookupTeam = (ref: LinearTeamRef) => (teamIdPattern.test(ref.team) ? teamById(ref) : teamByKey(ref));

  const loadTeam = Effect.fn("linear.loadTeam")(function* (ref: LinearTeamRef) {
    const team = yield* lookupTeam(ref);
    if (!team) {
      return yield* unavailable(`Linear team not found: ${ref.team}`);
    }
    return packTeam(team);
  });

  const mutate = Effect.fn("linear.mutate")(function* (
    ref: LinearTeamRef,
    operation: string,
    run: (sdk: LinearSdk) => PromiseLike<{ readonly success: boolean }>,
  ) {
    const payload = yield* call(ref, run);
    yield* requireSuccess(operation, payload);
  });

  const ensureLabel = Effect.fn("linear.ensureLabel")(function* (ref: LinearTeamRef, name: string) {
    const team = yield* loadTeam(ref);
    const existing = team.labels.find((label) => label.name === name);
    if (existing) return existing.id;
    const payload = yield* call(ref, (sdk) => sdk.createIssueLabel({ teamId: team.id, name }));
    yield* requireSuccess("issueLabelCreate", payload);
    if (!payload.issueLabelId) {
      return yield* unavailable(`Linear issueLabelCreate returned no label for ${name}`);
    }
    return payload.issueLabelId;
  });

  return {
    listIssues: (ref: LinearTeamRef) => Effect.map(loadTeam(ref), (team) => team.issues),
    listWorkflowStates: (ref: LinearTeamRef) =>
      Effect.map(loadTeam(ref), (team): ReadonlyArray<RawWorkflowState> => team.states),
    listComments: (ref: LinearTeamRef, issueId: string) =>
      Effect.gen(function* () {
        const data = yield* rawData(ref, commentsQuery, { id: issueId });
        const payload = yield* Effect.mapError(decodeComments(data), toUnavailable);
        return (payload.issue?.comments.nodes ?? []).flatMap(toRawComment);
      }),
    addLabel: (ref: LinearTeamRef, issueId: string, label: string) =>
      Effect.gen(function* () {
        const labelId = yield* ensureLabel(ref, label);
        yield* mutate(ref, "issueAddLabel", (sdk) => sdk.issueAddLabel(issueId, labelId));
      }),
    removeLabel: (ref: LinearTeamRef, issueId: string, label: string) =>
      Effect.gen(function* () {
        const team = yield* loadTeam(ref);
        const found = team.labels.find((entry) => entry.name === label);
        if (!found) return;
        yield* mutate(ref, "issueRemoveLabel", (sdk) => sdk.issueRemoveLabel(issueId, found.id));
      }),
    setState: (ref: LinearTeamRef, issueId: string, stateId: string) =>
      mutate(ref, "issueUpdate", (sdk) => sdk.updateIssue(issueId, { stateId })),
    createComment: (ref: LinearTeamRef, issueId: string, body: string) =>
      mutate(ref, "commentCreate", (sdk) => sdk.createComment({ issueId, body })),
    editComment: (ref: LinearTeamRef, commentId: string, body: string) =>
      mutate(ref, "commentUpdate", (sdk) => sdk.updateComment(commentId, { body })),
  };
};

export type LinearClientService = ReturnType<typeof make>;

export class LinearClient extends Context.Service<LinearClient, LinearClientService>()(
  "@clanker-forge/engine/linear/client/LinearClient",
) {}

export const layer = Layer.effect(LinearClient, Effect.map(CredentialStore, make));
