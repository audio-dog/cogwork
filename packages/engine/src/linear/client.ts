import { type Priority, resolvePriority } from "@cogwork/contracts";
import {
  LinearError,
  LinearErrorType,
  LinearClient as LinearSdk,
  parseLinearError,
  RatelimitedLinearError,
} from "@linear/sdk";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  type Credential,
  type CredentialAccount,
  CredentialStore,
  type CredentialStoreService,
} from "../credential-store";
import { defaultTrackerCooldown, IssueTrackerError } from "../issue-tracker";

export interface LinearTeamRef {
  readonly team: string;
  // The whole workspace reads through one Linear credential, so every team ref carries the same
  // account; the team key alone routes writes, decoupled from which credential fetches them.
  readonly account: CredentialAccount;
}

// Linear's request budget is per user and shared across every key that user owns, so every workspace
// reading through the same token has to back off together.
export const rateLimitScopeOf = (tokenEnv: string) => `linear:${tokenEnv}`;

export interface RawIssue {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly url: string;
  readonly labels: ReadonlyArray<string>;
  readonly assignees: ReadonlyArray<string>;
  readonly stateName: string;
  readonly stateType: string;
  readonly openBlockers: number;
  readonly priority: Priority;
}

export interface ObservedRawIssue extends RawIssue {
  readonly coordinationComments: ReadonlyArray<RawComment>;
}

type LinearAuthorAssociation = "MEMBER" | "NONE" | "OWNER";

export interface RawComment {
  readonly id: string;
  readonly authorId: string | null;
  readonly authorAssociation: LinearAuthorAssociation;
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
  readonly actorUserId: string;
  readonly ledgerMarker: string;
  readonly proposalMarker: string;
}

const CommentNode = Schema.Struct({
  id: Schema.String,
  body: Schema.String,
  createdAt: Schema.String,
  user: Schema.NullOr(Schema.Struct({ id: Schema.String })),
});

const ProseCommentNode = Schema.Struct({
  id: Schema.String,
  body: Schema.String,
  createdAt: Schema.String,
  user: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      active: Schema.Boolean,
      guest: Schema.Boolean,
      app: Schema.Boolean,
      owner: Schema.Boolean,
    }),
  ),
});

const RelationNode = Schema.Struct({
  type: Schema.String,
  issue: Schema.Struct({ state: Schema.Struct({ type: Schema.String }) }),
});

const PageInfoNode = Schema.Struct({
  hasNextPage: Schema.Boolean,
  endCursor: Schema.NullOr(Schema.String),
});

const RelationConnection = Schema.Struct({
  nodes: Schema.Array(RelationNode),
  pageInfo: PageInfoNode,
});

interface RelationPaginationState {
  readonly after: string;
  readonly seen: ReadonlySet<string>;
}

interface CommentPaginationState {
  readonly after: string | null;
  readonly seen: ReadonlySet<string>;
  readonly commentCount: number;
  readonly proseBytes: number;
}

interface CommentPage {
  readonly body: string;
  readonly comments: ReadonlyArray<RawComment>;
}

const IssueNode = Schema.Struct({
  id: Schema.String,
  identifier: Schema.String,
  title: Schema.String,
  url: Schema.String,
  priority: Schema.optional(Schema.Finite),
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

const IssuesTeamNode = Schema.Struct({
  issues: Schema.Struct({
    nodes: Schema.Array(IssueNode),
    pageInfo: PageInfoNode,
  }),
});

const MetaTeamNode = Schema.Struct({
  states: Schema.Struct({ nodes: Schema.Array(StateNode) }),
});

const LabelTeamNode = Schema.Struct({
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

const IssueRelationsPayload = Schema.Struct({
  issue: Schema.NullOr(Schema.Struct({ inverseRelations: RelationConnection })),
});

const decodeComments = Schema.decodeUnknownEffect(CommentsPayload);
const decodeWorkspaceLabels = Schema.decodeUnknownEffect(WorkspaceLabelsPayload);
const decodeIssueRelations = Schema.decodeUnknownEffect(IssueRelationsPayload);

const unavailable = (message: string) => new IssueTrackerError({ reason: "unavailable", message });
const toUnavailable = (error: { readonly message: string }) => unavailable(error.message);

const labelCreateRefused = (ref: LinearTeamRef, name: string) => (error: IssueTrackerError) =>
  new IssueTrackerError({
    reason: error.reason,
    message: `Linear refused creating the "${name}" label in team ${ref.team}: ${error.message}`,
    retryable: error.reason === "rate-limited",
    retryAfterMillis: error.retryAfterMillis,
    connectionId: error.connectionId,
  });

const isAuthStatus = (status: number | undefined) => status === 401 || status === 403;
const transientErrorTypes = new Set([
  LinearErrorType.NetworkError,
  LinearErrorType.InternalError,
  LinearErrorType.LockTimeout,
]);

const reasonFor = (cause: unknown): IssueTrackerError["reason"] => {
  if (cause instanceof RatelimitedLinearError) return "rate-limited";
  if (
    cause instanceof LinearError &&
    (isAuthStatus(cause.status) || cause.type === LinearErrorType.AuthenticationError)
  ) {
    return "auth";
  }
  return "unavailable";
};

const isTransportCause = (cause: LinearError) =>
  cause.type === LinearErrorType.Unknown && cause.raw instanceof TypeError;

const permanentErrorTypes = new Set([LinearErrorType.Forbidden, LinearErrorType.FeatureNotAccessible]);

const isPermanentCause = (cause: unknown) =>
  cause instanceof LinearError && cause.type !== undefined && permanentErrorTypes.has(cause.type);

const isTransientCause = (cause: unknown) =>
  cause instanceof LinearError &&
  (isTransportCause(cause) || (cause.type !== undefined && transientErrorTypes.has(cause.type)));

const finiteOrNull = (value: number | undefined) =>
  value !== undefined && Number.isFinite(value) ? value : null;

const retryAfterMillisOf = (cause: unknown, nowMillis: number) => {
  if (!(cause instanceof RatelimitedLinearError)) return undefined;
  const retryAfterSeconds = finiteOrNull(cause.retryAfter);
  if (retryAfterSeconds !== null) return retryAfterSeconds * 1000;
  const resetAtMillis = finiteOrNull(cause.requestsResetAt);
  return resetAtMillis === null ? undefined : Math.max(0, resetAtMillis - nowMillis);
};

// Reason stays `unavailable` for a permanent refusal on purpose: `auth` makes the credential store
// invalidate a token that is working.
const fromSdkError = (cause: unknown, nowMillis: number) =>
  new IssueTrackerError({
    reason: reasonFor(cause),
    message: cause instanceof Error ? cause.message : String(cause),
    ...(isPermanentCause(cause) ? { retryable: false } : {}),
    retryAfterMillis: retryAfterMillisOf(cause, nowMillis),
  });

class LinearRequestFailure extends Data.TaggedError("LinearRequestFailure")<{
  readonly error: IssueTrackerError;
  readonly retryable: boolean;
}> {}

const fromSdkFailure = (cause: unknown, nowMillis: number) =>
  new LinearRequestFailure({ error: fromSdkError(cause, nowMillis), retryable: isTransientCause(cause) });

const nonRetryableFailure = (error: IssueTrackerError) =>
  new LinearRequestFailure({ error, retryable: false });

const isoMillis = (millis: number) =>
  Option.match(DateTime.make(millis), { onNone: () => String(millis), onSome: DateTime.formatIso });

const isTransient = (failure: LinearRequestFailure) => failure.retryable;
const transientBackoff = Schedule.exponential("500 millis", 2).pipe(Schedule.jittered);
const transientAttemptDeadline = "30 seconds";
const paginationDeadline = "5 minutes";

const withTransientAttemptDeadline = <A, R>(attempt: Effect.Effect<A, LinearRequestFailure, R>) =>
  attempt.pipe(
    Effect.timeout(transientAttemptDeadline),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(
        new LinearRequestFailure({
          error: unavailable(`Linear request timed out after ${transientAttemptDeadline}`),
          retryable: true,
        }),
      ),
    ),
  );

const withPaginationDeadline = <A, R>(kind: string, operation: Effect.Effect<A, IssueTrackerError, R>) =>
  operation.pipe(
    Effect.timeout(paginationDeadline),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(unavailable(`Linear ${kind} pagination timed out after ${paginationDeadline}`)),
    ),
  );

const teamIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const millisFromIso = (value: string) => {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
};

const issuePageSize = 100;
const labelPageSize = 50;
const workContextCommentLimit = 10_000;
const workContextProseByteLimit = 16 * 1024 * 1024;
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
      priority
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

// Mirrors the classify-side assignee ownership gate: when the workspace names an allowlist, an
// issue owned by anyone else can never classify, so fetching it only costs pages.
const issuesFilter = (assigneeIds: ReadonlyArray<string> | null) => ({
  state: { type: { nin: ["completed"] } },
  ...(assigneeIds !== null && assigneeIds.length > 0 ? { assignee: { id: { in: assigneeIds } } } : {}),
});

const metaSelection = `
  states { nodes { id name type } }`;

// Linear caps an unpaginated connection at 50, and a team can hold more labels than that.
const labelSelection = `
  id
  labels(filter: { name: { eq: $label } }, first: 1) { nodes { id name } }`;

// A workspace-level label belongs to no team, so no team-scoped connection lists it.
const workspaceLabelQuery = `
query WorkspaceLabelByName($label: String!) {
  issueLabels(filter: { name: { eq: $label }, team: { null: true } }, first: 1) {
    nodes { id name }
  }
}`;

const commentsQuery = `
query IssueComments($id: String!, $after: String) {
  issue(id: $id) {
    description
    comments(first: 100, after: $after, orderBy: createdAt) {
      nodes {
        id
        body
        createdAt
        user { id active guest app owner }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const issueRelationsQuery = `
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
const labelShape = teamShape(LabelTeamNode, labelSelection, ", $label: String!");
const issuesShape = teamShape(IssuesTeamNode, issuesSelection(""), issuesArgs);
const coordinatedIssuesShape = teamShape(
  IssuesTeamNode,
  issuesSelection(coordinationFields),
  `${issuesArgs}, $bot: ID!, $ledger: String!, $proposal: String!`,
);

const isResolvedBlocker = (stateType: string) => stateType === "completed" || stateType === "canceled";

const isOpenBlocker = (relation: typeof RelationNode.Type) =>
  relation.type === "blocks" && !isResolvedBlocker(relation.issue.state.type);

const countOpenBlockers = (relations: ReadonlyArray<typeof RelationNode.Type>) =>
  relations.filter(isOpenBlocker).length;

const continuationCursor = Effect.fn("linear.continuationCursor")(function* (
  pageInfo: typeof PageInfoNode.Type,
  issueIdentifier: string,
  kind = "relation",
) {
  return yield* pageInfo.hasNextPage
    ? Option.match(Option.fromNullOr(pageInfo.endCursor), {
        onNone: () => Effect.fail(unavailable(`Linear ${kind} page missing cursor: ${issueIdentifier}`)),
        onSome: (cursor) => Effect.succeed(Option.some(cursor)),
      })
    : Effect.succeed(Option.none<string>());
});

// Linear uses 0 for "No priority"; anything outside 1-4 resolves to the default.
const linearPriorityNames: Record<number, string> = { 1: "urgent", 2: "high", 3: "medium", 4: "low" };
export const linearPriority = (value: number | undefined): Priority =>
  resolvePriority(value === undefined ? null : linearPriorityNames[value]);

const toRawIssue = (issue: typeof IssueNode.Type, openBlockers: number) => ({
  id: issue.id,
  identifier: issue.identifier,
  title: issue.title,
  url: issue.url,
  labels: issue.labels.nodes.map((label) => label.name),
  assignees: issue.assignee ? [issue.assignee.id] : [],
  stateName: issue.state.name,
  stateType: issue.state.type,
  openBlockers,
  priority: linearPriority(issue.priority),
});

const toRawComment = (comment: typeof CommentNode.Type) => ({
  id: comment.id,
  authorId: comment.user?.id ?? null,
  authorAssociation: "NONE" as const,
  body: comment.body,
  createdAtMillis: millisFromIso(comment.createdAt),
});

const lacksSteeringAuthority = (user: NonNullable<(typeof ProseCommentNode.Type)["user"]>) =>
  !user.active || user.guest || user.app;

const authorAssociationRules = [
  { when: lacksSteeringAuthority, value: "NONE" },
  { when: (user: NonNullable<(typeof ProseCommentNode.Type)["user"]>) => user.owner, value: "OWNER" },
] as const;

const authorAssociationOf = (user: (typeof ProseCommentNode.Type)["user"]): LinearAuthorAssociation =>
  user === null ? "NONE" : (authorAssociationRules.find(({ when }) => when(user))?.value ?? "MEMBER");

const toRawProseComment = (comment: typeof ProseCommentNode.Type) => ({
  id: comment.id,
  authorId: comment.user?.id ?? null,
  authorAssociation: authorAssociationOf(comment.user),
  body: comment.body,
  createdAtMillis: millisFromIso(comment.createdAt),
});

const rawCommentBytes = (comment: RawComment) =>
  Buffer.byteLength(comment.body) + Buffer.byteLength(comment.authorId ?? "");

const toObservedIssue = (issue: typeof IssueNode.Type, openBlockers: number): ObservedRawIssue => ({
  ...toRawIssue(issue, openBlockers),
  coordinationComments: [...(issue.comments?.nodes ?? []), ...(issue.proposalComments?.nodes ?? [])].map(
    toRawComment,
  ),
});

const requireSuccess = (operation: string, payload: { readonly success: boolean }) =>
  payload.success ? Effect.void : Effect.fail(unavailable(`Linear ${operation} failed`));

// A Linear API key authenticates as itself; an OAuth token is a bearer credential and has to reach
// the SDK as `accessToken` or it is sent without the `Bearer` prefix.
const sdkAuth = (credential: Credential) =>
  credential.source === "env" || credential.source === "stored-key"
    ? { apiKey: Redacted.value(credential.token) }
    : { accessToken: Redacted.value(credential.token) };

export const verifyCredential = Effect.fn("linear.verifyCredential")(function* (credential: Credential) {
  const nowMillis = yield* Clock.currentTimeMillis;
  yield* withTransientAttemptDeadline(
    Effect.tryPromise({
      try: (signal) => new LinearSdk({ ...sdkAuth(credential), signal }).viewer,
      catch: (cause) => fromSdkFailure(cause, nowMillis),
    }),
  ).pipe(Effect.mapError((failure) => failure.error));
});

const make = Effect.fn("linear.client.make")(function* (credentials: CredentialStoreService) {
  const resumeAt = yield* Ref.make(new Map<string, number>());

  const holdOff = Effect.fn("linear.holdOff")(function* (ref: LinearTeamRef, nowMillis: number) {
    const until = (yield* Ref.get(resumeAt)).get(rateLimitScopeOf(ref.account.tokenEnv));
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
        rateLimitScopeOf(ref.account.tokenEnv),
        nowMillis + (error.retryAfterMillis ?? Duration.toMillis(defaultTrackerCooldown)),
      ),
    );

  // Client credentials have no refresh token, so local invalidation mints a replacement. Reconcile
  // also revokes the connection so operators can see and repair the rejected credential.
  const noteFailure = (ref: LinearTeamRef, nowMillis: number, error: IssueTrackerError) => {
    if (error.reason === "rate-limited") return noteRateLimit(ref, nowMillis, error);
    if (error.reason === "auth") return credentials.invalidate(ref.account);
    return Effect.void;
  };

  const credentialFor = (ref: LinearTeamRef) =>
    Effect.mapError(
      credentials.bearerToken(ref.account),
      (error) => new IssueTrackerError({ reason: "auth", message: error.message }),
    );

  const callWithCredential = Effect.fn("linear.callWithCredential")(function* <A>(
    ref: LinearTeamRef,
    credential: Credential,
    run: (sdk: LinearSdk) => PromiseLike<A>,
  ) {
    return yield* Effect.retry(
      Effect.gen(function* () {
        const attemptStartedAt = yield* Clock.currentTimeMillis;
        yield* Effect.mapError(holdOff(ref, attemptStartedAt), nonRetryableFailure);
        return yield* withTransientAttemptDeadline(
          Effect.tryPromise({
            try: (signal) => run(new LinearSdk({ ...sdkAuth(credential), signal })),
            catch: (cause) => fromSdkFailure(cause, attemptStartedAt),
          }),
        );
      }),
      { while: isTransient, schedule: transientBackoff, times: 3 },
    ).pipe(
      Effect.mapError((failure) => failure.error),
      Effect.tapError((error) =>
        Effect.flatMap(Clock.currentTimeMillis, (nowMillis) => noteFailure(ref, nowMillis, error)),
      ),
    );
  });

  const call = Effect.fn("linear.call")(function* <A>(
    ref: LinearTeamRef,
    run: (sdk: LinearSdk) => PromiseLike<A>,
  ) {
    const credential = yield* credentialFor(ref);
    return yield* callWithCredential(ref, credential, run);
  });

  // The SDK fetches nested models lazily, so typed reads cost two extra requests per issue; observe
  // only stays inside Linear's rate limit while these reads stay single documents.
  const rawData = Effect.fn("linear.rawRequest")(function* (
    ref: LinearTeamRef,
    document: string,
    variables: Record<string, unknown>,
  ) {
    const response = yield* call(ref, (sdk) =>
      sdk.client
        .rawRequest<unknown, Record<string, unknown>>(document, variables)
        .catch((cause) => Promise.reject(parseLinearError(cause))),
    );
    if (response.data === undefined) {
      return yield* unavailable("Linear response missing data");
    }
    return response.data;
  });

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
    assigneeIds: ReadonlyArray<string> | null = null,
  ) {
    const shape = coordination ? coordinatedIssuesShape : issuesShape;
    const scopeVariables = coordination
      ? {
          bot: coordination.actorUserId,
          ledger: coordination.ledgerMarker,
          proposal: coordination.proposalMarker,
        }
      : {};
    const filter = issuesFilter(assigneeIds);
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

  const mutate = Effect.fn("linear.mutate")(function* (
    ref: LinearTeamRef,
    operation: string,
    run: (sdk: LinearSdk) => PromiseLike<{ readonly success: boolean }>,
  ) {
    const payload = yield* call(ref, run);
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

  const ensureLabel = Effect.fn("linear.ensureLabel")(function* (ref: LinearTeamRef, name: string) {
    const { teamId, labelId } = yield* resolveLabel(ref, name);
    if (labelId !== null) return labelId;
    const payload = yield* Effect.mapError(
      call(ref, (sdk) => sdk.createIssueLabel({ teamId, name })),
      labelCreateRefused(ref, name),
    );
    yield* requireSuccess("issueLabelCreate", payload);
    if (!payload.issueLabelId) {
      return yield* unavailable(`Linear issueLabelCreate returned no label for ${name}`);
    }
    return payload.issueLabelId;
  });

  const readProse = (ref: LinearTeamRef, issueId: string) => {
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
      if (!withinAdmissionLimit) {
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

  return {
    authenticatedUserId: Effect.fn("linear.authenticatedUserId")(function* (ref: LinearTeamRef) {
      const credential = yield* credentialFor(ref);
      if (credential.identity) return credential.identity.actorUserId;
      return yield* callWithCredential(ref, credential, (sdk) => sdk.viewer.then((viewer) => viewer.id));
    }),
    observeIssues,
    listWorkflowStates: (ref: LinearTeamRef) =>
      Effect.map(loadTeam(ref, metaShape), (team): ReadonlyArray<RawWorkflowState> => team.states.nodes),
    listComments: Effect.fn("linear.listComments")(function* (ref: LinearTeamRef, issueId: string) {
      const data = yield* rawData(ref, commentsQuery, { id: issueId, after: null });
      const payload = yield* Effect.mapError(decodeComments(data), toUnavailable);
      return (payload.issue?.comments.nodes ?? []).map(toRawProseComment);
    }),
    readProse,
    addLabel: (ref: LinearTeamRef, issueId: string, label: string) =>
      Effect.gen(function* () {
        const labelId = yield* ensureLabel(ref, label);
        yield* mutate(ref, "issueAddLabel", (sdk) => sdk.issueAddLabel(issueId, labelId));
      }),
    removeLabel: (ref: LinearTeamRef, issueId: string, label: string) =>
      Effect.gen(function* () {
        const { labelId } = yield* resolveLabel(ref, label);
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
