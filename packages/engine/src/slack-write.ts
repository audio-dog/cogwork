import { randomUUID } from "node:crypto";
import { type WorkflowActionTarget, type WorkflowCatalogEntry, WorkflowCatalogKey } from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { ConnectionStore, type ConnectionStoreService } from "./connection";
import { SlackClient, type SlackClientService, type SlackMessage, type SlackSession } from "./slack-source";

type SlackMessageTarget = Omit<Extract<WorkflowActionTarget, { readonly _tag: "SlackMessage" }>, "_tag">;

export interface SlackPostReceipt {
  readonly team: string;
  readonly channel: string;
  readonly ts: string;
  readonly threadTs: string | null;
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
    channel: string,
    message: string,
    writeKey: string,
  ) => Effect.Effect<SlackPostReceipt, SlackWriteError>;
  readonly replyInThread: (
    target: SlackMessageTarget,
    message: string,
    writeKey: string,
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
const PostResponse = Schema.Struct({ ok: Schema.Literal(true), channel: Schema.String, ts: Schema.String });
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
  {
    matches: (response: HttpClientResponse.HttpClientResponse) =>
      response.status < 200 || response.status >= 300,
    make: (response: HttpClientResponse.HttpClientResponse) =>
      fail("invalid", false, `Slack rejected the write (${response.status})`),
  },
] satisfies ReadonlyArray<{
  readonly matches: (response: HttpClientResponse.HttpClientResponse) => boolean;
  readonly make: (response: HttpClientResponse.HttpClientResponse) => SlackWriteError;
}>;

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

const connectionFailure = (error: { readonly message: string }) =>
  fail("connection-not-ready", true, error.message);

const sessionFor = Effect.fn("SlackWrite.session")(function* (connections: ConnectionStoreService) {
  const connection = yield* connections.findSystem("slack").pipe(Effect.mapError(connectionFailure));
  if (!connection) return yield* fail("connection-not-ready", true, "Slack Connection is not established");
  const credential = yield* connections.bearer(connection.id).pipe(Effect.mapError(connectionFailure));
  if (!credential.identity) {
    return yield* fail("connection-not-ready", true, "Slack Connection identity is unavailable");
  }
  return {
    team: credential.identity.organization,
    user: credential.identity.actorUserId,
    token: credential.token,
  } satisfies SlackSession;
});

const decodeResponse =
  <S extends Schema.Top>(schema: S, message: string) =>
  (input: unknown) =>
    Schema.decodeUnknownEffect(schema)(input).pipe(Effect.mapError(() => fail("unavailable", true, message)));

const decodeDraftResponse = (input: unknown) =>
  Schema.decodeUnknownEffect(DraftResponse)(input).pipe(
    Effect.mapError(() => fail("draft-outcome-unknown", false, "Slack returned an unreadable draft result")),
  );

const parseDraftJson = (text: string) =>
  Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
    Effect.mapError(() => fail("draft-outcome-unknown", false, "Slack returned an unreadable draft result")),
  );

const readDraftEvent = (response: HttpClientResponse.HttpClientResponse) =>
  response.stream.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.takeUntil((line) => line === ""),
    Stream.runFoldEffect(
      () => "",
      (text, line) => {
        const next = text === "" ? line : `${text}\n${line}`;
        return next.length <= responseByteLimit
          ? Effect.succeed(next)
          : Effect.fail(fail("draft-outcome-unknown", false, "Slack draft result exceeded the size limit"));
      },
    ),
    Effect.flatMap((text) => {
      const data = text
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      return data
        ? parseDraftJson(data)
        : Effect.fail(fail("draft-outcome-unknown", false, "Slack returned an empty draft result"));
    }),
    Effect.mapError((error) =>
      error._tag === "SlackWriteError"
        ? error
        : fail("draft-outcome-unknown", false, "Slack draft outcome is unknown"),
    ),
  );

const draftBodyReaders = new Map<
  string,
  (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<unknown, SlackWriteError>
>([
  [
    "application/json",
    (response) =>
      response.json.pipe(
        Effect.mapError(() => fail("draft-outcome-unknown", false, "Slack draft outcome is unknown")),
      ),
  ],
  ["text/event-stream", readDraftEvent],
]);

const readDraftBody = (response: HttpClientResponse.HttpClientResponse) => {
  const mediaType = response.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const reader = draftBodyReaders.get(mediaType);
  return reader
    ? reader(response)
    : Effect.fail(
        fail("draft-outcome-unknown", false, `Slack returned unsupported content type "${mediaType}"`),
      );
};

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
  const response = yield* http
    .execute(request.pipe(HttpClientRequest.bearerToken(Redacted.value(session.token))))
    .pipe(
      Effect.mapError((error) => fail("unavailable", true, error.message)),
      Effect.timeout(requestDeadline),
      Effect.catchTag("TimeoutError", () =>
        fail("unavailable", true, `Slack did not respond within ${requestDeadline}`),
      ),
    );
  const responseFailure = responseFailureRules.find(({ matches }) => matches(response));
  if (responseFailure) return yield* responseFailure.make(response);
  const bodyValue = yield* response.json.pipe(
    Effect.mapError(() => fail("unavailable", true, "Slack returned an unreadable response")),
  );
  return {
    envelope: yield* decodeResponse(SlackEnvelope, "Slack returned an unexpected response")(bodyValue),
    body: bodyValue,
  };
});

const writeKeyMessage = (messages: ReadonlyArray<SlackMessage>, writeKey: string) =>
  messages.find(({ metadata }) => metadata?.eventType === "cogwork_write" && metadata.writeKey === writeKey);

const receipt = (session: SlackSession, message: SlackMessage): SlackPostReceipt => ({
  team: session.team,
  channel: message.channel,
  ts: message.ts,
  threadTs: message.threadTs,
});

const sourceFailure = (error: { readonly reason: string; readonly message: string }) => {
  const retryable = error.reason !== "auth";
  const reason = error.reason === "rate-limited" ? "rate-limited" : "unavailable";
  return fail(reason, retryable, error.message);
};

const requireTeam = (session: SlackSession, target: SlackMessageTarget) =>
  session.team === target.team
    ? Effect.void
    : Effect.fail(fail("invalid", false, `Slack item belongs to team ${target.team}`));

const post = Effect.fn("SlackWrite.post")(function* (
  http: HttpClient.HttpClient,
  session: SlackSession,
  channel: string,
  message: string,
  writeKey: string,
  threadTs: string | null,
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
  return { team: session.team, channel: posted.channel, ts: posted.ts, threadTs } satisfies SlackPostReceipt;
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
  const response = yield* http
    .execute(
      request.pipe(
        HttpClientRequest.bearerToken(Redacted.value(session.token)),
        HttpClientRequest.setHeader("accept", "application/json, text/event-stream"),
      ),
    )
    .pipe(
      Effect.mapError(() => fail("draft-outcome-unknown", false, "Slack draft outcome is unknown")),
      Effect.timeout(requestDeadline),
      Effect.catchTag("TimeoutError", () =>
        fail("draft-outcome-unknown", false, `Slack draft outcome is unknown after ${requestDeadline}`),
      ),
    );
  const responseFailure = responseFailureRules.find(({ matches }) => matches(response));
  if (responseFailure) return yield* responseFailure.make(response);
  const body = yield* readDraftBody(response);
  return yield* decodeDraftResponse(body);
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
  client: SlackClientService,
  http: HttpClient.HttpClient,
  connections: ConnectionStoreService,
): SlackWriteService => {
  const session = sessionFor(connections);
  return {
    sendMessage: Effect.fn("SlackWrite.sendMessage")(function* (channel, message, writeKey) {
      const connected = yield* session;
      const messages = yield* client.history(connected, channel, 0).pipe(Effect.mapError(sourceFailure));
      const existing = writeKeyMessage(messages, writeKey);
      if (existing) return receipt(connected, existing);
      return yield* post(http, connected, channel, message, writeKey, null);
    }),
    replyInThread: Effect.fn("SlackWrite.replyInThread")(function* (target, message, writeKey) {
      const connected = yield* session;
      yield* requireTeam(connected, target);
      const messages = yield* client
        .replies(connected, target.channel, target.threadTs)
        .pipe(Effect.mapError(sourceFailure));
      const existing = writeKeyMessage(messages, writeKey);
      if (existing) return receipt(connected, existing);
      return yield* post(http, connected, target.channel, message, writeKey, target.threadTs);
    }),
    addReaction: Effect.fn("SlackWrite.addReaction")(function* (target, emoji) {
      const connected = yield* session;
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
      const connected = yield* session;
      yield* requireTeam(connected, target);
      const response = yield* draftResponse(http, connected, target, message);
      const failure = draftFailureRules.find(({ matches }) => matches(response));
      if (failure) return yield* failure.make(response);
    }),
  };
};

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
