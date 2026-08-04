import { LinearError, LinearClient as LinearSdk, RatelimitedLinearError } from "@linear/sdk";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import {
  type ClientCredentialsRef,
  type Credential,
  CredentialStore,
  type CredentialStoreService,
} from "../credential-store";
import { IssueTrackerError } from "../issue-tracker";

export interface LinearTeamRef {
  readonly team: string;
  readonly tokenEnv: string;
  readonly organization: string | null;
  readonly clientCredentials: ClientCredentialsRef | null;
  readonly oauthClientId: string | null;
}

// Linear's request budget is per user and shared across every key that user owns, so every workspace
// reading through the same token has to back off together.
export const rateLimitScopeOf = (tokenEnv: string) => `linear:${tokenEnv}`;

export interface RawIssue {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly labels: ReadonlyArray<string>;
  readonly stateName: string;
  readonly stateType: string;
  readonly openBlockers: number;
}

export interface ObservedRawIssue extends RawIssue {
  readonly coordinationComments: ReadonlyArray<RawComment>;
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

export interface CoordinationScope {
  readonly botUserId: string;
  readonly ledgerMarker: string;
}

const CommentNode = Schema.Struct({
  id: Schema.String,
  body: Schema.String,
  createdAt: Schema.String,
  user: Schema.NullOr(Schema.Struct({ id: Schema.String })),
});

const RelationNode = Schema.Struct({
  type: Schema.String,
  issue: Schema.Struct({ state: Schema.Struct({ type: Schema.String }) }),
});

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
  inverseRelations: Schema.optional(Schema.Struct({ nodes: Schema.Array(RelationNode) })),
  comments: Schema.optional(Schema.Struct({ nodes: Schema.Array(CommentNode) })),
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

const IssuesTeamNode = Schema.Struct({
  issues: Schema.Struct({ nodes: Schema.Array(IssueNode) }),
});

const MetaTeamNode = Schema.Struct({
  id: Schema.String,
  states: Schema.Struct({ nodes: Schema.Array(StateNode) }),
  labels: Schema.Struct({ nodes: Schema.Array(LabelNode) }),
});

const CommentsPayload = Schema.Struct({
  issue: Schema.NullOr(
    Schema.Struct({
      comments: Schema.Struct({ nodes: Schema.Array(CommentNode) }),
    }),
  ),
});

const decodeComments = Schema.decodeUnknownEffect(CommentsPayload);

const unavailable = (message: string) => new IssueTrackerError({ reason: "unavailable", message });
const toUnavailable = (error: { readonly message: string }) => unavailable(error.message);

const isAuthStatus = (status: number | undefined) => status === 401 || status === 403;

const reasonFor = (cause: unknown): IssueTrackerError["reason"] => {
  if (cause instanceof RatelimitedLinearError) return "rate-limited";
  if (cause instanceof LinearError && isAuthStatus(cause.status)) return "auth";
  return "unavailable";
};

const finiteOrNull = (value: number | undefined) =>
  value !== undefined && Number.isFinite(value) ? value : null;

const retryAfterMillisOf = (cause: unknown, nowMillis: number) => {
  if (!(cause instanceof RatelimitedLinearError)) return undefined;
  const retryAfterSeconds = finiteOrNull(cause.retryAfter);
  if (retryAfterSeconds !== null) return retryAfterSeconds * 1000;
  const resetAtMillis = finiteOrNull(cause.requestsResetAt);
  return resetAtMillis === null ? undefined : Math.max(0, resetAtMillis - nowMillis);
};

const fromSdkError = (cause: unknown, nowMillis: number) =>
  new IssueTrackerError({
    reason: reasonFor(cause),
    message: cause instanceof Error ? cause.message : String(cause),
    retryAfterMillis: retryAfterMillisOf(cause, nowMillis),
  });

const isoMillis = (millis: number) =>
  Option.match(DateTime.make(millis), { onNone: () => String(millis), onSome: DateTime.formatIso });

const defaultCooldownMillis = 60_000;

const isTransient = (error: IssueTrackerError) => error.reason === "unavailable";
const transientBackoff = Schedule.exponential("500 millis", 2).pipe(Schedule.jittered);

const teamIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const millisFromIso = (value: string) => {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
};

const issuePageSize = 100;
const labelPageSize = 50;
// Linear rejects any single query above 10,000 complexity points, and a nested connection multiplies
// its children by its page size, so these sizes multiply out rather than add up.
const relationPageSize = 8;
const coordinationPageSize = 5;

const issueFields = `
      id
      identifier
      title
      labels(first: ${labelPageSize}) { nodes { name } }
      state { name type }
      inverseRelations(first: ${relationPageSize}) {
        nodes { type issue { state { type } } }
      }`;

const coordinationFields = `
      comments(
        filter: { user: { id: { eq: $bot } }, body: { contains: $ledger } }
        orderBy: createdAt
        first: ${coordinationPageSize}
      ) {
        nodes { id body createdAt user { id } }
      }`;

const issuesSelection = (coordination: string) => `
  issues(filter: { state: { type: { nin: ["completed"] } } }, first: ${issuePageSize}) {
    nodes {${issueFields}${coordination}
    }
  }`;

const metaSelection = `
  id
  states { nodes { id name type } }
  labels { nodes { id name } }`;

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

interface TeamAddressing<A> {
  readonly document: string;
  readonly variables: (team: string) => Record<string, unknown>;
  readonly decode: (data: unknown) => Effect.Effect<A | null, IssueTrackerError>;
}

interface TeamShape<A> {
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

const metaShape = teamShape(MetaTeamNode, metaSelection);
const issuesShape = teamShape(IssuesTeamNode, issuesSelection(""));
const coordinatedIssuesShape = teamShape(
  IssuesTeamNode,
  issuesSelection(coordinationFields),
  ", $bot: ID!, $ledger: String!",
);

const isResolvedBlocker = (stateType: string) => stateType === "completed" || stateType === "canceled";

// Linear's nested inverseRelations connection can't be filtered or ordered server-side, so a full
// page may hide further blockers; when the page is full we can't prove the issue is unblocked, so we
// hold it rather than dispatch it ahead of a dependency.
const openBlockersOf = (issue: typeof IssueNode.Type) => {
  const relations = issue.inverseRelations?.nodes ?? [];
  const open = relations.filter(
    (relation) => relation.type === "blocks" && !isResolvedBlocker(relation.issue.state.type),
  ).length;
  if (open > 0) return open;
  return relations.length >= relationPageSize ? 1 : 0;
};

const toRawIssue = (issue: typeof IssueNode.Type): RawIssue => ({
  id: issue.id,
  identifier: issue.identifier,
  title: issue.title,
  labels: issue.labels.nodes.map((label) => label.name),
  stateName: issue.state.name,
  stateType: issue.state.type,
  openBlockers: openBlockersOf(issue),
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

const toObservedIssue = (issue: typeof IssueNode.Type): ObservedRawIssue => ({
  ...toRawIssue(issue),
  coordinationComments: (issue.comments?.nodes ?? []).flatMap(toRawComment),
});

const requireSuccess = (operation: string, payload: { readonly success: boolean }) =>
  payload.success ? Effect.void : Effect.fail(unavailable(`Linear ${operation} failed`));

// A Linear API key authenticates as itself; an OAuth token is a bearer credential and has to reach
// the SDK as `accessToken` or it is sent without the `Bearer` prefix.
const sdkAuth = (credential: Credential) =>
  credential.source === "env"
    ? { apiKey: Redacted.value(credential.token) }
    : { accessToken: Redacted.value(credential.token) };

const accountFor = (ref: LinearTeamRef) => ({
  key: ref.team,
  issueTracker: "linear",
  organization: ref.organization,
  tokenEnv: ref.tokenEnv,
  clientCredentials: ref.clientCredentials,
  oauthClientId: ref.oauthClientId,
});

const make = Effect.fn("linear.client.make")(function* (credentials: CredentialStoreService) {
  const resumeAt = yield* Ref.make(new Map<string, number>());

  const sdkFor = Effect.fn("linear.sdk")(function* (ref: LinearTeamRef) {
    const credential = yield* Effect.mapError(
      credentials.bearerToken(accountFor(ref)),
      (error) => new IssueTrackerError({ reason: "auth", message: error.message }),
    );
    return new LinearSdk(sdkAuth(credential));
  });

  const holdOff = Effect.fn("linear.holdOff")(function* (ref: LinearTeamRef, nowMillis: number) {
    const until = (yield* Ref.get(resumeAt)).get(rateLimitScopeOf(ref.tokenEnv));
    if (until === undefined || until <= nowMillis) return;
    return yield* new IssueTrackerError({
      reason: "rate-limited",
      message: `Linear rate limit active; resuming after ${isoMillis(until)}`,
      retryAfterMillis: until - nowMillis,
    });
  });

  const noteRateLimit = (ref: LinearTeamRef, nowMillis: number, error: IssueTrackerError) =>
    Ref.update(resumeAt, (entries) =>
      new Map(entries).set(
        rateLimitScopeOf(ref.tokenEnv),
        nowMillis + (error.retryAfterMillis ?? defaultCooldownMillis),
      ),
    );

  // A client-credentials token carries no refresh token, so a rejection is the only signal the
  // store ever gets that the token it holds has to be minted again.
  const noteFailure = (ref: LinearTeamRef, nowMillis: number, error: IssueTrackerError) => {
    if (error.reason === "rate-limited") return noteRateLimit(ref, nowMillis, error);
    if (error.reason === "auth") return credentials.invalidate(accountFor(ref));
    return Effect.void;
  };

  const call = Effect.fn("linear.call")(function* <A>(
    ref: LinearTeamRef,
    run: (sdk: LinearSdk) => PromiseLike<A>,
  ) {
    const nowMillis = yield* Clock.currentTimeMillis;
    yield* holdOff(ref, nowMillis);
    const sdk = yield* sdkFor(ref);
    return yield* Effect.tapError(
      Effect.tryPromise({ try: () => run(sdk), catch: (cause) => fromSdkError(cause, nowMillis) }),
      (error) => noteFailure(ref, nowMillis, error),
    );
  });

  // The SDK fetches nested models lazily, so typed reads cost two extra requests per issue; observe
  // only stays inside Linear's rate limit while these reads stay single documents.
  const rawData = Effect.fn("linear.rawRequest")(function* (
    ref: LinearTeamRef,
    document: string,
    variables: Record<string, unknown>,
  ) {
    const response = yield* Effect.retry(
      call(ref, (sdk) => sdk.client.rawRequest<unknown, Record<string, unknown>>(document, variables)),
      { while: isTransient, schedule: transientBackoff, times: 3 },
    );
    if (response.data === undefined) {
      return yield* unavailable("Linear response missing data");
    }
    return response.data;
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
    const team = coordination
      ? yield* loadTeam(ref, coordinatedIssuesShape, {
          bot: coordination.botUserId,
          ledger: coordination.ledgerMarker,
        })
      : yield* loadTeam(ref, issuesShape);
    return team.issues.nodes.map(toObservedIssue);
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
    const team = yield* loadTeam(ref, metaShape);
    const existing = team.labels.nodes.find((label) => label.name === name);
    if (existing) return existing.id;
    const payload = yield* call(ref, (sdk) => sdk.createIssueLabel({ teamId: team.id, name }));
    yield* requireSuccess("issueLabelCreate", payload);
    if (!payload.issueLabelId) {
      return yield* unavailable(`Linear issueLabelCreate returned no label for ${name}`);
    }
    return payload.issueLabelId;
  });

  return {
    observeIssues,
    listWorkflowStates: (ref: LinearTeamRef) =>
      Effect.map(loadTeam(ref, metaShape), (team): ReadonlyArray<RawWorkflowState> => team.states.nodes),
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
        const team = yield* loadTeam(ref, metaShape);
        const found = team.labels.nodes.find((entry) => entry.name === label);
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
});

export type LinearClientService = Effect.Success<ReturnType<typeof make>>;

export class LinearClient extends Context.Service<LinearClient, LinearClientService>()(
  "@clanker-forge/engine/linear/client/LinearClient",
) {}

export const layer = Layer.effect(LinearClient, Effect.flatMap(CredentialStore, make));
