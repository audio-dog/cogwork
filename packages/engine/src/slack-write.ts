import { randomUUID } from "node:crypto";
import {
  SlackChannelId,
  SlackMessageTs,
  SlackTeamId,
  type SlackWriteKey,
  type WorkflowActionTarget,
  type WorkflowCatalogEntry,
  WorkflowCatalogKey,
} from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { ConnectionStore, type ConnectionStoreService } from "./connection";
import { readJsonEventStream } from "./json-event-stream";
import {
  SlackClient,
  type SlackClientService,
  type SlackMessage,
  type SlackSession,
  slackSession,
} from "./slack-source";

type SlackMessageTarget = Omit<Extract<WorkflowActionTarget, { readonly _tag: "SlackMessage" }>, "_tag">;

export interface SlackPostReceipt {
  readonly team: SlackTeamId;
  readonly channel: SlackChannelId;
  readonly ts: SlackMessageTs;
  readonly threadTs: SlackMessageTs | null;
}

export class SlackWriteError extends Schema.TaggedError<SlackWriteError>()("SlackWriteError", {
  reason: Schema.Literals([
    "connection-not-ready",
    "invalid",
    "unavailable",
    "rate-limited",
    "draft-outcome-unknown",
  ]),
  retryable: Schema.Boolean,
  message: Schema.String,
}) {}

export interface SlackWriteService {
  readonly sendMessage: (
    channel: SlackChannelId,
    message: string,
    writeKey: SlackWriteKey,
  ) => Effect.Effect<SlackPostReceipt, SlackWriteError>;
  readonly replyInThread: (
    target: SlackMessageTarget,
    message: string,
    writeKey: SlackWriteKey,
  ) => Effect.Effect<SlackPostReceipt, SlackWriteError>;
  readonly addReaction: (target: SlackMessageTarget, emoji: string) => Effect.Effect<void, SlackWriteError>;
  readonly draftReply: (target: SlackMessageTarget, message: string) => Effect.Effect<void, SlackWriteError>;
}

export class SlackWrite extends Context.Service<SlackWrite, SlackWriteService>()(
  "@cogwork/engine/slack-write/SlackWrite",
) {}

const slackApi = "https://slack.com/api";
const slackMcp = "https://mcp.slack.com/mcp";
const requestDeadline = "30 seconds";
const responseByteLimit = 1024 * 1024;

const SlackEnvelope = Schema.Struct({
  ok: Schema.Boolean,
  error: Schema.optional(Schema.String),
});
const PostResponse = Schema.Struct({
  ok: Schema.Literal(true),
  channel: SlackChannelId,
  ts: SlackMessageTs,
});
const ReactionResponse = Schema.Struct({ ok: Schema.Literal(true) });
const DraftResponse = Schema.Union([
  Schema.Struct({
    jsonrpc: Schema.Literal("2.0"),
    id: Schema.String,
    result: Schema.Struct({
      content: Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })),
      isError: Schema.optional(Schema.Boolean),
    }),
  }),
  Schema.Struct({
    jsonrpc: Schema.Literal("2.0"),
    id: Schema.String,
    error: Schema.Struct({ code: Schema.Finite, message: Schema.String }),
  }),
]);

const fail = (reason: SlackWriteError["reason"], retryable: boolean, message: string) =>
  new SlackWriteError({ reason, retryable, message });

const retryAfter = (response: HttpClientResponse.HttpClientResponse) => {
  const seconds = Number(response.headers["retry-after"]);
  const isValidRetryAfter = Number.isFinite(seconds) && seconds >= 0;
  return isValidRetryAfter ? ` Retry after ${seconds} seconds.` : "";
};

const invalidResponseFailureRule = {
  matches: (response: HttpClientResponse.HttpClientResponse) =>
    response.status < 200 || response.status >= 300,
  make: (response: HttpClientResponse.HttpClientResponse) =>
    fail("invalid", false, `Slack rejected the write (${response.status})`),
};

const responseFailureRules = [
  {
    matches: (response: HttpClientResponse.HttpClientResponse) => response.status === 429,
    make: (response: HttpClientResponse.HttpClientResponse) =>
      fail("rate-limited", true, `Slack rate limited the write.${retryAfter(response)}`),
  },
  {
    matches: (response: HttpClientResponse.HttpClientResponse) =>
      response.status === 401 || response.status === 403,
    make: (response: HttpClientResponse.HttpClientResponse) =>
      fail("connection-not-ready", false, `Slack rejected the Connection token (${response.status})`),
  },
  {
    matches: (response: HttpClientResponse.HttpClientResponse) => response.status >= 500,
    make: (response: HttpClientResponse.HttpClientResponse) =>
      fail("unavailable", true, `Slack write failed (${response.status})`),
  },
  invalidResponseFailureRule,
] satisfies ReadonlyArray<{
  readonly matches: (response: HttpClientResponse.HttpClientResponse) => boolean;
  readonly make: (response: HttpClientResponse.HttpClientResponse) => SlackWriteError;
}>;

const draftResponseFailureRules = [
  ...responseFailureRules.slice(0, 2),
  {
    matches: (response: HttpClientResponse.HttpClientResponse) => response.status >= 500,
    make: (response: HttpClientResponse.HttpClientResponse) =>
      fail("draft-outcome-unknown", false, `Slack draft outcome is unknown (${response.status})`),
  },
  invalidResponseFailureRule,
];

const retryableApiErrors = new Set(["fatal_error", "internal_error", "ratelimited", "service_unavailable"]);
const authApiErrors = new Set([
  "account_inactive",
  "invalid_auth",
  "not_authed",
  "token_expired",
  "token_revoked",
]);

const apiFailureRules = [
  {
    matches: (error: string) => error === "ratelimited",
    make: () => fail("rate-limited", true, "Slack rate limited the write"),
  },
  {
    matches: (error: string) => authApiErrors.has(error),
    make: (error: string) => fail("connection-not-ready", false, `Slack API error: ${error}`),
  },
] satisfies ReadonlyArray<{
  readonly matches: (error: string) => boolean;
  readonly make: (error: string) => SlackWriteError;
}>;

const apiFailure = (error: string) => {
  const matched = apiFailureRules.find(({ matches }) => matches(error));
  if (matched) return matched.make(error);
  const retryable = retryableApiErrors.has(error);
  return fail(retryable ? "unavailable" : "invalid", retryable, `Slack API error: ${error}`);
};

const decodeResponse =
  <S extends Schema.Top>(schema: S, message: string) =>
  (input: unknown) =>
    Schema.decodeUnknownEffect(schema)(input).pipe(Effect.mapError(() => fail("unavailable", true, message)));

const decodeDraftResponse = (input: unknown) =>
  Schema.decodeUnknownEffect(DraftResponse)(input).pipe(
    Effect.mapError(() => fail("draft-outcome-unknown", false, "Slack returned an unreadable draft result")),
  );

const decodeSlackTeamId = Schema.decodeEffect(SlackTeamId);

const readSlackBody = (response: HttpClientResponse.HttpClientResponse, reason: SlackWriteError["reason"]) =>
  readJsonEventStream(response, "Slack response", responseByteLimit).pipe(
    Effect.mapError((error) => fail(reason, reason === "unavailable", error.message)),
  );

const apiRequest = (method: string, body: unknown) =>
  HttpClientRequest.bodyJson(HttpClientRequest.post(`${slackApi}/${method}`), body).pipe(
    Effect.mapError(() => fail("invalid", false, "Could not encode the Slack write")),
  );

const apiResponse = Effect.fn("SlackWrite.apiResponse")(function* (
  http: HttpClient.HttpClient,
  session: SlackSession,
  method: string,
  body: unknown,
) {
  const request = yield* apiRequest(method, body);
  return yield* Effect.gen(function* () {
    const response = yield* http
      .execute(request.pipe(HttpClientRequest.bearerToken(Redacted.value(session.token))))
      .pipe(Effect.mapError((error) => fail("unavailable", true, error.message)));
    const responseFailure = responseFailureRules.find(({ matches }) => matches(response));
    if (responseFailure) return yield* responseFailure.make(response);
    const bodyValue = yield* readSlackBody(response, "unavailable");
    return {
      envelope: yield* decodeResponse(SlackEnvelope, "Slack returned an unexpected response")(bodyValue),
      body: bodyValue,
    };
  }).pipe(
    Effect.timeout(requestDeadline),
    Effect.catchTag("TimeoutError", () =>
      fail("unavailable", true, `Slack did not respond within ${requestDeadline}`),
    ),
  );
});

const receipt = Effect.fn("SlackWrite.receipt")(function* (session: SlackSession, message: SlackMessage) {
  return {
    team: yield* decodeSlackTeamId(session.team).pipe(
      Effect.mapError(() => fail("connection-not-ready", false, "Slack Connection team is invalid")),
    ),
    channel: yield* Schema.decodeEffect(SlackChannelId)(message.channel).pipe(
      Effect.mapError(() => fail("unavailable", true, "Slack returned an invalid channel")),
    ),
    ts: yield* Schema.decodeEffect(PostResponse.fields.ts)(message.ts).pipe(
      Effect.mapError(() => fail("unavailable", true, "Slack returned an invalid timestamp")),
    ),
    threadTs: yield* Schema.decodeEffect(Schema.NullOr(PostResponse.fields.ts))(message.threadTs).pipe(
      Effect.mapError(() => fail("unavailable", true, "Slack returned an invalid thread timestamp")),
    ),
  };
});

const sourceFailureReasons = new Map<string, SlackWriteError["reason"]>([
  ["auth", "connection-not-ready"],
  ["connection-not-ready", "connection-not-ready"],
  ["rate-limited", "rate-limited"],
]);

const sourceFailure = (error: { readonly reason: string; readonly message: string }) => {
  const retryable = error.reason !== "auth";
  const reason = sourceFailureReasons.get(error.reason) ?? "unavailable";
  return fail(reason, retryable, error.message);
};

type SlackWriteClient = Pick<SlackClientService, "findWrite">;

const findWrite = (
  client: SlackWriteClient,
  session: SlackSession,
  channel: SlackChannelId,
  threadTs: SlackMessageTs | null,
  writeKey: SlackWriteKey,
) =>
  client.findWrite(session, { channel, threadTs, writeKey }).pipe(
    Effect.mapError(sourceFailure),
    Effect.timeout(requestDeadline),
    Effect.catchTag("TimeoutError", () =>
      fail("unavailable", true, `Slack write lookup did not finish within ${requestDeadline}`),
    ),
  );

const requireTeam = (session: SlackSession, target: SlackMessageTarget) =>
  session.team === target.team
    ? Effect.void
    : Effect.fail(fail("invalid", false, `Slack item belongs to team ${target.team}`));

const post = Effect.fn("SlackWrite.post")(function* (
  http: HttpClient.HttpClient,
  session: SlackSession,
  channel: SlackChannelId,
  message: string,
  writeKey: SlackWriteKey,
  threadTs: SlackMessageTs | null,
) {
  const response = yield* apiResponse(http, session, "chat.postMessage", {
    channel,
    text: message,
    ...(threadTs ? { thread_ts: threadTs } : {}),
    metadata: { event_type: "cogwork_write", event_payload: { write_key: writeKey } },
  });
  if (!response.envelope.ok) return yield* apiFailure(response.envelope.error ?? "unknown");
  const posted = yield* decodeResponse(
    PostResponse,
    "Slack returned an invalid posted message",
  )(response.body);
  const team = yield* decodeSlackTeamId(session.team).pipe(
    Effect.mapError(() => fail("connection-not-ready", false, "Slack Connection team is invalid")),
  );
  return { team, channel: posted.channel, ts: posted.ts, threadTs } satisfies SlackPostReceipt;
});

const draftRequest = (target: SlackMessageTarget, message: string) =>
  HttpClientRequest.bodyJson(HttpClientRequest.post(slackMcp), {
    jsonrpc: "2.0",
    id: randomUUID(),
    method: "tools/call",
    params: {
      name: "slack_send_message_draft",
      arguments: { channel_id: target.channel, message, thread_ts: target.threadTs },
    },
  }).pipe(Effect.mapError(() => fail("invalid", false, "Could not encode the Slack draft")));

const draftResponse = Effect.fn("SlackWrite.draftResponse")(function* (
  http: HttpClient.HttpClient,
  session: SlackSession,
  target: SlackMessageTarget,
  message: string,
) {
  const request = yield* draftRequest(target, message);
  return yield* Effect.gen(function* () {
    const response = yield* http
      .execute(
        request.pipe(
          HttpClientRequest.bearerToken(Redacted.value(session.token)),
          HttpClientRequest.setHeader("accept", "application/json, text/event-stream"),
        ),
      )
      .pipe(Effect.mapError(() => fail("draft-outcome-unknown", false, "Slack draft outcome is unknown")));
    const responseFailure = draftResponseFailureRules.find(({ matches }) => matches(response));
    if (responseFailure) return yield* responseFailure.make(response);
    const body = yield* readSlackBody(response, "draft-outcome-unknown");
    return yield* decodeDraftResponse(body);
  }).pipe(
    Effect.timeout(requestDeadline),
    Effect.catchTag("TimeoutError", () =>
      fail("draft-outcome-unknown", false, `Slack draft outcome is unknown after ${requestDeadline}`),
    ),
  );
});

type DraftResult = typeof DraftResponse.Type;

const draftFailureRules = [
  {
    matches: (response: DraftResult) => "error" in response,
    make: (response: DraftResult) =>
      fail("invalid", false, "error" in response ? response.error.message : "Slack rejected the draft"),
  },
  {
    matches: (response: DraftResult) => "result" in response && response.result.isError === true,
    make: () => fail("invalid", false, "Slack rejected the draft"),
  },
] satisfies ReadonlyArray<{
  readonly matches: (response: DraftResult) => boolean;
  readonly make: (response: DraftResult) => SlackWriteError;
}>;

export const make = (
  client: SlackWriteClient,
  http: HttpClient.HttpClient,
  connections: ConnectionStoreService,
): SlackWriteService => ({
  sendMessage: Effect.fn("SlackWrite.sendMessage")(function* (channel, message, writeKey) {
    const connected = yield* slackSession(connections).pipe(Effect.mapError(sourceFailure));
    const existing = yield* findWrite(client, connected, channel, null, writeKey);
    if (existing) return yield* receipt(connected, existing);
    return yield* post(http, connected, channel, message, writeKey, null);
  }),
  replyInThread: Effect.fn("SlackWrite.replyInThread")(function* (target, message, writeKey) {
    const connected = yield* slackSession(connections).pipe(Effect.mapError(sourceFailure));
    yield* requireTeam(connected, target);
    const existing = yield* findWrite(client, connected, target.channel, target.threadTs, writeKey);
    if (existing) return yield* receipt(connected, existing);
    return yield* post(http, connected, target.channel, message, writeKey, target.threadTs);
  }),
  addReaction: Effect.fn("SlackWrite.addReaction")(function* (target, emoji) {
    const connected = yield* slackSession(connections).pipe(Effect.mapError(sourceFailure));
    yield* requireTeam(connected, target);
    const response = yield* apiResponse(http, connected, "reactions.add", {
      channel: target.channel,
      timestamp: target.ts,
      name: emoji,
    });
    if (response.envelope.error === "already_reacted") return;
    if (!response.envelope.ok) return yield* apiFailure(response.envelope.error ?? "unknown");
    yield* decodeResponse(ReactionResponse, "Slack returned an invalid reaction result")(response.body);
  }),
  draftReply: Effect.fn("SlackWrite.draftReply")(function* (target, message) {
    const connected = yield* slackSession(connections).pipe(Effect.mapError(sourceFailure));
    yield* requireTeam(connected, target);
    const response = yield* draftResponse(http, connected, target, message);
    const failure = draftFailureRules.find(({ matches }) => matches(response));
    if (failure) return yield* failure.make(response);
  }),
});

export const layer = Layer.effect(
  SlackWrite,
  Effect.all([SlackClient, HttpClient.HttpClient, ConnectionStore]).pipe(
    Effect.map(([client, http, connections]) => make(client, http, connections)),
  ),
);

const key = Schema.decodeSync(WorkflowCatalogKey);
const liveParameter = (id: string) => ({ id, required: true, source: "live" as const, values: [] });
const action = (
  id: string,
  name: string,
  agentInputs: ReadonlyArray<string>,
  parameters: WorkflowCatalogEntry["parameters"],
  actsOn: ReadonlyArray<string>,
) =>
  ({
    key: key(`slack.${id}`),
    name,
    kind: "action",
    system: "slack",
    connection: "slack",
    requires: [],
    parameters,
    itemKind: null,
    actsOn,
    requiresWorkspace: false,
    workspaceSource: null,
    permissionProfile: "read-only",
    agentInputs,
    emits: [],
  }) satisfies WorkflowCatalogEntry;

const slackItems = ["slack-message", "slack-conversation"];

export const slackActionEntries = [
  action("send-message", "Send a message", ["message"], [liveParameter("channel")], ["*"]),
  action("reply-in-thread", "Reply in thread", ["reply"], [], slackItems),
  action("add-reaction", "Add a reaction", [], [liveParameter("emoji")], slackItems),
  action("draft-reply-in-slack", "Draft a reply in Slack", ["reply"], [], slackItems),
] satisfies ReadonlyArray<WorkflowCatalogEntry>;
