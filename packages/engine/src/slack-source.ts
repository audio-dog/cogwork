import {
  type SlackChannelId,
  type SlackMessageTs,
  type SlackWriteKey,
  type WorkflowAvailability,
  type WorkflowCatalogEntry,
  WorkflowCatalogKey,
  type WorkflowOption,
} from "@cogwork/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
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
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { ConnectionStore, type ConnectionStoreService } from "./connection";
import { readJsonEventStream } from "./json-event-stream";
import {
  SourceFailure,
  type TriggerEvent,
  type TriggerSource,
  type TriggerSubscription,
} from "./trigger-source";
import type { SystemOptions } from "./workflow-options";

export interface SlackSession {
  readonly team: string;
  readonly user: string;
  readonly token: Redacted.Redacted<string>;
}

export interface SlackMetadata {
  readonly eventType: string;
  readonly writeKey: string | null;
}

export interface SlackReaction {
  readonly name: string;
  readonly users: ReadonlyArray<string>;
}

export interface SlackMessage {
  readonly channel: string;
  readonly ts: string;
  readonly threadTs: string | null;
  readonly text: string;
  readonly user: string | null;
  readonly appId: string | null;
  readonly metadata: SlackMetadata | null;
  readonly reactions: ReadonlyArray<SlackReaction>;
}

export interface SlackChannel {
  readonly id: string;
  readonly name: string;
}

export interface SlackWriteLookup {
  readonly channel: SlackChannelId;
  readonly threadTs: SlackMessageTs | null;
  readonly writeKey: SlackWriteKey;
}

export interface SlackClientService {
  readonly searchMessages: (
    session: SlackSession,
    oldestMillis: number,
  ) => Effect.Effect<ReadonlyArray<SlackMessage>, SourceFailure>;
  readonly searchChannelMessages: (
    session: SlackSession,
    channel: string,
    oldestMillis: number,
  ) => Effect.Effect<ReadonlyArray<SlackMessage>, SourceFailure>;
  readonly history: (
    session: SlackSession,
    channel: string,
    oldestMillis: number,
  ) => Effect.Effect<ReadonlyArray<SlackMessage>, SourceFailure>;
  readonly reactions: (
    session: SlackSession,
    oldestMillis: number,
  ) => Effect.Effect<ReadonlyArray<SlackMessage>, SourceFailure>;
  readonly replies: (
    session: SlackSession,
    channel: string,
    threadTs: string,
  ) => Effect.Effect<ReadonlyArray<SlackMessage>, SourceFailure>;
  readonly findWrite: (
    session: SlackSession,
    lookup: SlackWriteLookup,
  ) => Effect.Effect<SlackMessage | null, SourceFailure>;
  readonly channels: (session: SlackSession) => Effect.Effect<ReadonlyArray<SlackChannel>, SourceFailure>;
  readonly emojis: (session: SlackSession) => Effect.Effect<ReadonlyArray<string>, SourceFailure>;
  readonly channelName: (session: SlackSession, channel: string) => Effect.Effect<string, SourceFailure>;
  readonly userName: (session: SlackSession, user: string) => Effect.Effect<string, SourceFailure>;
  readonly permalink: (
    session: SlackSession,
    channel: string,
    messageTs: string,
  ) => Effect.Effect<string, SourceFailure>;
}

export class SlackClient extends Context.Service<SlackClient, SlackClientService>()(
  "@cogwork/engine/slack-source/SlackClient",
) {}

const mentionedKey = Schema.decodeSync(WorkflowCatalogKey)("slack.i-am-mentioned");
const ambientKey = Schema.decodeSync(WorkflowCatalogKey)("slack.message-in-channel");
const reactionKey = Schema.decodeSync(WorkflowCatalogKey)("slack.reaction-added");

const parameter = (
  id: string,
  required: boolean,
  source: "fixed" | "live",
  values: ReadonlyArray<string>,
) => ({ id, required, source, values });

const entry = (
  key: typeof mentionedKey,
  name: string,
  itemKind: "slack-message" | "slack-conversation",
  parameters: WorkflowCatalogEntry["parameters"],
): WorkflowCatalogEntry => ({
  key,
  name,
  kind: "trigger",
  system: "slack",
  connection: "slack",
  requires: [],
  parameters,
  itemKind,
  actsOn: [],
  requiresWorkspace: false,
  permissionProfile: "read-only",
  agentInputs: [],
  emits: [],
});

const catchUpParameter = parameter("catch-up-at-most", false, "fixed", [
  "0",
  "86400000",
  "604800000",
  "2592000000",
]);

export const slackEntries: ReadonlyArray<WorkflowCatalogEntry> = [
  entry(mentionedKey, "I am mentioned", "slack-message", [
    parameter("channel", false, "live", []),
    catchUpParameter,
  ]),
  entry(ambientKey, "Message in a channel", "slack-conversation", [
    parameter("channel", true, "live", []),
    parameter("author", false, "fixed", ["anyone", "me"]),
    parameter("quiet-for", false, "fixed", ["0", "60000", "300000", "900000"]),
    parameter("at-most-every", false, "fixed", ["0", "300000", "1800000", "3600000"]),
    catchUpParameter,
  ]),
  entry(reactionKey, "Reaction added", "slack-message", [
    parameter("emoji", true, "live", []),
    catchUpParameter,
  ]),
];

const cogworkAppId = "A0CD4UYHKPX";
const defaultCatchUpMillis = Duration.toMillis(Duration.days(7));
const defaultQuietMillis = Duration.toMillis(Duration.minutes(5));
const defaultAtMostMillis = Duration.toMillis(Duration.minutes(30));
const searchBoundaryPaddingMillis = Duration.toMillis(Duration.days(1));
const pollSchedule = Schedule.spaced("1 minute");

const parameterValue = (subscription: TriggerSubscription, id: string) =>
  subscription.parameters.find((parameter) => parameter.id === id)?.value;

const durationOf = (subscription: TriggerSubscription, id: string, fallback: number) => {
  const parsed = Number(parameterValue(subscription, id));
  const isValidDuration = Number.isFinite(parsed) && parsed >= 0;
  return isValidDuration ? parsed : fallback;
};

const timestampMillis = (timestamp: string) => Math.floor(Number(timestamp) * 1_000);

const searchAfterDate = (oldestMillis: number) =>
  DateTime.makeUnsafe(Math.max(0, oldestMillis - searchBoundaryPaddingMillis)).pipe(
    DateTime.formatIsoDateUtc,
  );

const withCatchUpWindow = (subscription: TriggerSubscription, startedAtMillis: number) => {
  const activeSince = subscription.catchUp?.since ?? startedAtMillis;
  const window = durationOf(subscription, "catch-up-at-most", defaultCatchUpMillis);
  return {
    ...subscription,
    catchUp: { since: Math.max(activeSince, startedAtMillis - window) },
  } satisfies TriggerSubscription;
};

const catchUpSince = (subscription: TriggerSubscription, now: number) => subscription.catchUp?.since ?? now;

const isCogworkMessage = (message: SlackMessage) =>
  message.appId === cogworkAppId &&
  message.metadata?.eventType === "cogwork_write" &&
  typeof message.metadata.writeKey === "string";

const rootTimestampOf = (message: SlackMessage) => message.threadTs ?? message.ts;

const ambientEmissionKey = (subscription: TriggerSubscription, channel: string, threadTs: string) =>
  `${subscription.workflow}:${subscription.trigger}:${channel}:${threadTs}`;

const ambientSubscriptionKey = (subscription: TriggerSubscription) =>
  `${subscription.workflow}:${subscription.trigger}`;

export const sourceFailure = (
  reason: SourceFailure["reason"],
  message: string,
  retryAfterMillis: number | null = null,
) => new SourceFailure({ source: "slack", reason, retryAfterMillis, message });

const RawReaction = Schema.Struct({
  name: Schema.String,
  users: Schema.optional(Schema.Array(Schema.String)),
});

const RawMetadata = Schema.Struct({
  event_type: Schema.String,
  event_payload: Schema.Record(Schema.String, Schema.Unknown),
});

const RawMessage = Schema.Struct({
  ts: Schema.String,
  text: Schema.optional(Schema.String),
  user: Schema.optional(Schema.String),
  channel: Schema.optional(Schema.Struct({ id: Schema.String })),
  channel_id: Schema.optional(Schema.String),
  thread_ts: Schema.optional(Schema.String),
  app_id: Schema.optional(Schema.String),
  metadata: Schema.optional(RawMetadata),
  reactions: Schema.optional(Schema.Array(RawReaction)),
});

const ResponseMetadata = Schema.Struct({ next_cursor: Schema.optional(Schema.String) });
const SearchResponse = Schema.Struct({
  ok: Schema.Literal(true),
  messages: Schema.Struct({
    matches: Schema.Array(RawMessage),
    paging: Schema.optional(Schema.Struct({ page: Schema.Finite, pages: Schema.Finite })),
  }),
});
const HistoryResponse = Schema.Struct({
  ok: Schema.Literal(true),
  messages: Schema.Array(RawMessage),
  response_metadata: Schema.optional(ResponseMetadata),
});
const ReactionsResponse = Schema.Struct({
  ok: Schema.Literal(true),
  items: Schema.Array(
    Schema.Struct({
      type: Schema.String,
      channel: Schema.optional(Schema.String),
      message: Schema.optional(RawMessage),
    }),
  ),
  response_metadata: Schema.optional(ResponseMetadata),
});
const ChannelsResponse = Schema.Struct({
  ok: Schema.Literal(true),
  channels: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  response_metadata: Schema.optional(ResponseMetadata),
});
const EmojiResponse = Schema.Struct({
  ok: Schema.Literal(true),
  emoji: Schema.Record(Schema.String, Schema.String),
  categories: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.optional(Schema.String),
        emoji_names: Schema.optional(Schema.Array(Schema.String)),
      }),
    ),
  ),
});
const ChannelResponse = Schema.Struct({
  ok: Schema.Literal(true),
  channel: Schema.Struct({ name: Schema.String }),
});
const UserResponse = Schema.Struct({
  ok: Schema.Literal(true),
  user: Schema.Struct({
    name: Schema.String,
    real_name: Schema.optional(Schema.String),
    profile: Schema.optional(
      Schema.Struct({
        display_name: Schema.optional(Schema.String),
        real_name: Schema.optional(Schema.String),
      }),
    ),
  }),
});
const PermalinkResponse = Schema.Struct({ ok: Schema.Literal(true), permalink: Schema.String });
const SlackEnvelope = Schema.Struct({
  ok: Schema.Boolean,
  error: Schema.optional(Schema.String),
});

type RawMessageValue = typeof RawMessage.Type;

const normalizeMessage = (message: RawMessageValue, channel: string): SlackMessage => ({
  channel: message.channel_id ?? message.channel?.id ?? channel,
  ts: message.ts,
  threadTs: message.thread_ts ?? null,
  text: message.text ?? "",
  user: message.user ?? null,
  appId: message.app_id ?? null,
  metadata: message.metadata
    ? {
        eventType: message.metadata.event_type,
        writeKey:
          typeof message.metadata.event_payload.write_key === "string"
            ? message.metadata.event_payload.write_key
            : null,
      }
    : null,
  reactions: (message.reactions ?? []).map((reaction) => ({
    name: reaction.name,
    users: reaction.users ?? [],
  })),
});

const slackApi = "https://slack.com/api";
const slackRequestDeadline = "30 seconds";
const slackResponseByteLimit = 16 * 1024 * 1024;

const retryAfterMillis = (value: string | undefined) => {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : 0;
};

const authSlackErrors = new Set([
  "account_inactive",
  "invalid_auth",
  "not_authed",
  "token_expired",
  "token_revoked",
]);

const decodeSlack =
  <S extends Schema.Top>(schema: S) =>
  (input: unknown) =>
    Schema.decodeUnknownEffect(schema)(input).pipe(
      Effect.mapError(() => sourceFailure("decode", "Slack returned an unexpected response")),
    );

function callSlack(
  client: HttpClient.HttpClient,
  session: SlackSession,
  method: string,
  params: Readonly<Record<string, string>>,
) {
  return Effect.gen(function* () {
    const request = HttpClientRequest.get(`${slackApi}/${method}`).pipe(
      HttpClientRequest.setUrlParams(params),
      HttpClientRequest.bearerToken(Redacted.value(session.token)),
      HttpClientRequest.setHeader("accept", "application/json"),
    );
    const response = yield* client
      .execute(request)
      .pipe(Effect.mapError((error) => sourceFailure("unavailable", error.message)));
    const statusFailures = {
      401: () => sourceFailure("auth", "Slack rejected the Connection token"),
      403: () => sourceFailure("auth", "Slack rejected the Connection token"),
      429: () =>
        sourceFailure(
          "rate-limited",
          "Slack rate limited the request",
          retryAfterMillis(response.headers["retry-after"]),
        ),
    } satisfies Readonly<Record<number, () => SourceFailure>>;
    if (response.status !== 200) {
      const statusFailure = (statusFailures as Readonly<Record<number, () => SourceFailure>>)[
        response.status
      ];
      return yield* statusFailure?.() ??
        sourceFailure("unavailable", `Slack request failed (${response.status})`);
    }
    const body = yield* readJsonEventStream(response, "Slack response", slackResponseByteLimit).pipe(
      Effect.mapError((error) => sourceFailure("decode", error.message)),
    );
    const envelope = yield* decodeSlack(SlackEnvelope)(body);
    if (envelope.ok) return body;
    const error = envelope.error ?? "unknown";
    const apiFailures = {
      ratelimited: () =>
        sourceFailure(
          "rate-limited",
          "Slack rate limited the request",
          retryAfterMillis(response.headers["retry-after"]),
        ),
    } satisfies Readonly<Record<string, () => SourceFailure>>;
    const authFailure = authSlackErrors.has(error)
      ? sourceFailure("auth", `Slack API error: ${error}`)
      : sourceFailure("unavailable", `Slack API error: ${error}`);
    const apiFailure = (apiFailures as Readonly<Record<string, () => SourceFailure>>)[error];
    return yield* apiFailure?.() ?? authFailure;
  }).pipe(
    Effect.timeout(slackRequestDeadline),
    Effect.catchTag("TimeoutError", () =>
      sourceFailure("unavailable", `Slack request timed out after ${slackRequestDeadline}`),
    ),
  );
}

export const makeHttpClient = (client: HttpClient.HttpClient): SlackClientService => {
  const writeLookupPageLimit = 10;
  const cursorPages = <A>(
    session: SlackSession,
    method: string,
    params: Readonly<Record<string, string>>,
    decode: (input: unknown) => Effect.Effect<A, SourceFailure>,
    pageOf: (value: A) => readonly [ReadonlyArray<SlackMessage>, string],
  ) =>
    Stream.paginate("", (cursor) =>
      callSlack(client, session, method, cursor ? { ...params, cursor } : params).pipe(
        Effect.flatMap(decode),
        Effect.map(pageOf),
        Effect.map(([messages, next]) => [messages, next ? Option.some(next) : Option.none()] as const),
      ),
    ).pipe(Stream.runCollect);

  const findWrite = Effect.fn("SlackClient.findWrite")(function* (
    session: SlackSession,
    lookup: SlackWriteLookup,
  ) {
    const method = lookup.threadTs ? "conversations.replies" : "conversations.history";
    const params = {
      channel: lookup.channel,
      include_all_metadata: "true",
      limit: "200",
      ...(lookup.threadTs ? { ts: lookup.threadTs } : {}),
    };
    const pages = yield* Stream.paginate({ cursor: "", page: 0 }, ({ cursor, page }) =>
      callSlack(client, session, method, cursor ? { ...params, cursor } : params).pipe(
        Effect.flatMap(decodeSlack(HistoryResponse)),
        Effect.map((response) => {
          const messages = response.messages.map((message) => normalizeMessage(message, lookup.channel));
          const message = messages.find(
            ({ metadata }) =>
              metadata?.eventType === "cogwork_write" && metadata.writeKey === lookup.writeKey,
          );
          const nextCursor = response.response_metadata?.next_cursor ?? "";
          const shouldContinue = !message && nextCursor !== "" && page + 1 < writeLookupPageLimit;
          return [
            [{ message: message ?? null, nextCursor }],
            shouldContinue ? Option.some({ cursor: nextCursor, page: page + 1 }) : Option.none(),
          ] as const;
        }),
      ),
    ).pipe(Stream.runCollect);
    const message = pages.find((page) => page.message)?.message ?? null;
    if (message) return message;
    const truncated = pages.at(-1)?.nextCursor;
    return truncated
      ? yield* sourceFailure("unavailable", "Slack write lookup exceeded the page limit")
      : null;
  });

  const searchMessages = (session: SlackSession, query: string, oldestMillis: number) =>
    Stream.paginate(1, (page) =>
      callSlack(client, session, "search.messages", {
        query,
        sort: "timestamp",
        sort_dir: "asc",
        highlight: "false",
        count: "100",
        page: String(page),
      }).pipe(
        Effect.flatMap(decodeSlack(SearchResponse)),
        Effect.map((response) => {
          const paging = response.messages.paging;
          return [
            response.messages.matches.map((message) => normalizeMessage(message, message.channel_id ?? "")),
            paging && paging.page < paging.pages ? Option.some(page + 1) : Option.none(),
          ] as const;
        }),
      ),
    ).pipe(
      Stream.filter((message) => timestampMillis(message.ts) > oldestMillis),
      Stream.runCollect,
    );

  const channelName = Effect.fn("SlackClient.channelName")((session: SlackSession, channel: string) =>
    callSlack(client, session, "conversations.info", { channel }).pipe(
      Effect.flatMap(decodeSlack(ChannelResponse)),
      Effect.map((response) => response.channel.name),
    ),
  );

  return {
    searchMessages: Effect.fn("SlackClient.searchMessages")((session, oldestMillis) =>
      searchMessages(session, `<@${session.user}> after:${searchAfterDate(oldestMillis)}`, oldestMillis),
    ),
    searchChannelMessages: Effect.fn("SlackClient.searchChannelMessages")(
      function* (session, channel, oldestMillis) {
        const name = yield* channelName(session, channel);
        const messages = yield* searchMessages(
          session,
          `in:${name} after:${searchAfterDate(oldestMillis)}`,
          oldestMillis,
        );
        return messages.filter((message) => message.channel === channel);
      },
    ),
    history: Effect.fn("SlackClient.history")((session, channel, oldestMillis) =>
      cursorPages(
        session,
        "conversations.history",
        {
          channel,
          oldest: (oldestMillis / 1_000).toFixed(3),
          include_all_metadata: "true",
          limit: "200",
        },
        decodeSlack(HistoryResponse),
        (response) => [
          response.messages.map((message) => normalizeMessage(message, channel)),
          response.response_metadata?.next_cursor ?? "",
        ],
      ),
    ),
    reactions: Effect.fn("SlackClient.reactions")((session, oldestMillis) =>
      callSlack(client, session, "reactions.list", {
        user: session.user,
        full: "true",
        limit: "1000",
      }).pipe(
        Effect.flatMap(decodeSlack(ReactionsResponse)),
        Effect.map((response) =>
          response.items.flatMap((item) => {
            const isMessageItem =
              item.type === "message" && item.channel !== undefined && item.message !== undefined;
            return isMessageItem ? [normalizeMessage(item.message, item.channel)] : [];
          }),
        ),
        Effect.map((messages) => messages.filter((item) => timestampMillis(item.ts) > oldestMillis)),
      ),
    ),
    replies: Effect.fn("SlackClient.replies")((session, channel, threadTs) =>
      cursorPages(
        session,
        "conversations.replies",
        { channel, ts: threadTs, include_all_metadata: "true", limit: "200" },
        decodeSlack(HistoryResponse),
        (response) => [
          response.messages.map((message) => normalizeMessage(message, channel)),
          response.response_metadata?.next_cursor ?? "",
        ],
      ),
    ),
    findWrite,
    channels: Effect.fn("SlackClient.channels")((session) =>
      Stream.paginate("", (cursor) =>
        callSlack(client, session, "conversations.list", {
          types: "public_channel,private_channel",
          exclude_archived: "true",
          limit: "200",
          ...(cursor ? { cursor } : {}),
        }).pipe(
          Effect.flatMap(decodeSlack(ChannelsResponse)),
          Effect.map((response) => {
            const next = response.response_metadata?.next_cursor ?? "";
            return [response.channels, next ? Option.some(next) : Option.none()] as const;
          }),
        ),
      ).pipe(Stream.runCollect),
    ),
    emojis: Effect.fn("SlackClient.emojis")((session) =>
      callSlack(client, session, "emoji.list", { include_categories: "true" }).pipe(
        Effect.flatMap(decodeSlack(EmojiResponse)),
        Effect.map((response) =>
          [
            ...new Set([
              ...Object.keys(response.emoji),
              ...(response.categories ?? []).flatMap((category) => category.emoji_names ?? []),
            ]),
          ].toSorted(),
        ),
      ),
    ),
    channelName,
    userName: Effect.fn("SlackClient.userName")((session, user) =>
      callSlack(client, session, "users.info", { user }).pipe(
        Effect.flatMap(decodeSlack(UserResponse)),
        Effect.map(
          (response) =>
            response.user.profile?.display_name ||
            response.user.profile?.real_name ||
            response.user.real_name ||
            response.user.name,
        ),
      ),
    ),
    permalink: Effect.fn("SlackClient.permalink")((session, channel, messageTs) =>
      callSlack(client, session, "chat.getPermalink", { channel, message_ts: messageTs }).pipe(
        Effect.flatMap(decodeSlack(PermalinkResponse)),
        Effect.map((response) => response.permalink),
      ),
    ),
  };
};

export const httpClientLayer = Layer.effect(SlackClient, Effect.map(HttpClient.HttpClient, makeHttpClient));

export const slackSession = Effect.fn("SlackSource.session")(function* (connections: ConnectionStoreService) {
  const found = yield* connections
    .findSystem("slack")
    .pipe(Effect.mapError((error) => sourceFailure("connection-not-ready", error.message)));
  const connection = yield* found
    ? Effect.succeed(found)
    : sourceFailure("connection-not-ready", "Slack Connection is not established");
  const credential = yield* connections
    .bearer(connection.id)
    .pipe(Effect.mapError((error) => sourceFailure("connection-not-ready", error.message)));
  const identity = yield* credential.identity
    ? Effect.succeed(credential.identity)
    : sourceFailure("connection-not-ready", "Slack Connection identity is unavailable");
  return {
    team: identity.organization,
    user: identity.actorUserId,
    token: credential.token,
  } satisfies SlackSession;
});

const isContextLookupFailure = (failure: SourceFailure) =>
  failure.reason === "unavailable" || failure.reason === "decode";

const withContextFallback = <A>(lookup: Effect.Effect<A, SourceFailure>, fallback: A) =>
  lookup.pipe(Effect.catchIf(isContextLookupFailure, () => Effect.succeed(fallback)));

const mentionedUserIds = (text: string) =>
  [...text.matchAll(/<@([^>|]+)(?:\|[^>]+)?>/g)].flatMap((match) => (match[1] ? [match[1]] : []));

const resolvedWorkContext = Effect.fn("SlackSource.workContext")(function* (
  client: SlackClientService,
  session: SlackSession,
  selected: SlackMessage,
  thread: ReadonlyArray<SlackMessage>,
  heading: string,
) {
  const channelName = yield* withContextFallback(
    client.channelName(session, selected.channel),
    selected.channel,
  );
  const permalink = yield* withContextFallback(client.permalink(session, selected.channel, selected.ts), "");
  const mentionedUsers = thread.flatMap((message) => mentionedUserIds(message.text));
  const users = [
    ...new Set([...thread.flatMap((message) => (message.user ? [message.user] : [])), ...mentionedUsers]),
  ];
  const names = new Map(
    yield* Effect.forEach(users, (user) =>
      Effect.map(withContextFallback(client.userName(session, user), user), (name) => [user, name] as const),
    ),
  );
  const authorOf = (message: SlackMessage) =>
    message.user ? (names.get(message.user) ?? message.user) : "Slack";
  const resolvedText = (message: SlackMessage) =>
    message.text.replaceAll(
      /<@([^>|]+)(?:\|[^>]+)?>/g,
      (_mention, user: string) => `@${names.get(user) ?? user}`,
    );
  const permalinkLine = permalink ? [`Permalink: ${permalink}`] : [];
  return {
    body: [
      `${heading} in #${channelName}`,
      ...permalinkLine,
      "",
      `${authorOf(selected)}: ${resolvedText(selected)}`,
    ].join("\n"),
    comments: thread
      .filter((message) => message.ts !== selected.ts)
      .map((message) => ({
        author: authorOf(message),
        authorAssociation: null,
        body: resolvedText(message),
        createdAtMillis: timestampMillis(message.ts),
      })),
  };
});

const hydratedThread = Effect.fn("SlackSource.hydratedThread")(function* (
  client: SlackClientService,
  session: SlackSession,
  message: SlackMessage,
) {
  const replyLookup = yield* client.replies(session, message.channel, rootTimestampOf(message)).pipe(
    Effect.map((thread) => ({ thread, fromSlack: true }) as const),
    Effect.catchIf(isContextLookupFailure, () =>
      Effect.succeed({ thread: [message], fromSlack: false } as const),
    ),
  );
  const thread = replyLookup.thread;
  const hydrated = thread.find((candidate) => candidate.ts === message.ts);
  const selected = hydrated ?? message;
  const complete = thread.some((candidate) => candidate.ts === selected.ts) ? thread : [selected, ...thread];
  return {
    selected,
    selectedFromThread: replyLookup.fromSlack && hydrated !== undefined,
    thread: complete,
  } as const;
});

const messageEvent = (
  session: SlackSession,
  subscription: TriggerSubscription,
  message: SlackMessage,
  workContext: NonNullable<TriggerEvent["workContext"]>,
): TriggerEvent => ({
  key: {
    _tag: "SlackMessage",
    team: session.team,
    channel: message.channel,
    ts: message.ts,
    threadTs: rootTimestampOf(message),
  },
  revision: message.ts,
  cause: { _tag: "Person" },
  atMillis: timestampMillis(message.ts),
  entry: subscription.entry,
  workspace: null,
  parameters: subscription.parameters,
  workContext,
});

const mentionEvents = Effect.fn("SlackSource.mentionEvents")(function* (
  client: SlackClientService,
  session: SlackSession,
  subscription: TriggerSubscription,
  now: number,
) {
  const since = catchUpSince(subscription, now);
  const channel = parameterValue(subscription, "channel");
  const messages = yield* client.searchMessages(session, since);
  return yield* Effect.forEach(messages, (message) =>
    Effect.gen(function* () {
      if (timestampMillis(message.ts) <= since) return null;
      if (channel && message.channel !== channel) return null;
      const hydrated = yield* hydratedThread(client, session, message);
      const cogworkOriginUnknown = message.appId === cogworkAppId && !hydrated.selectedFromThread;
      if (cogworkOriginUnknown) return null;
      if (isCogworkMessage(hydrated.selected)) return null;
      if (!mentionedUserIds(hydrated.selected.text).includes(session.user)) return null;
      const workContext = yield* resolvedWorkContext(
        client,
        session,
        hydrated.selected,
        hydrated.thread,
        "Slack message",
      );
      return messageEvent(session, subscription, hydrated.selected, workContext);
    }),
  ).pipe(Effect.map((events) => events.filter((event) => event !== null)));
});

interface AmbientEmission {
  readonly revision: string;
  readonly atMillis: number;
}

interface AmbientRoot {
  readonly subscription: string;
  readonly channel: string;
  readonly message: SlackMessage;
  readonly latestMillis: number;
}

const trackedAmbientRoots = Effect.fn("SlackSource.trackedAmbientRoots")(function* (
  subscription: TriggerSubscription,
  channel: string,
  now: number,
  discovered: ReadonlyArray<SlackMessage>,
  tracked: Ref.Ref<ReadonlyMap<string, AmbientRoot>>,
) {
  const subscriptionId = ambientSubscriptionKey(subscription);
  const oldestMillis = catchUpSince(subscription, now);
  return yield* Ref.modify(tracked, (current) => {
    const retained = new Map(
      [...current].filter(([, root]) => {
        const belongsToSubscription = root.subscription === subscriptionId && root.channel === channel;
        return !belongsToSubscription || root.latestMillis > oldestMillis;
      }),
    );
    const next = discovered.reduce((roots, message) => {
      const key = ambientEmissionKey(subscription, channel, rootTimestampOf(message));
      const previous = roots.get(key);
      return new Map(roots).set(key, {
        subscription: subscriptionId,
        channel,
        message,
        latestMillis: Math.max(previous?.latestMillis ?? 0, timestampMillis(message.ts)),
      });
    }, retained);
    const messages = [...next.values()]
      .filter((root) => root.subscription === subscriptionId && root.channel === channel)
      .map((root) => root.message);
    return [messages, next];
  });
});

const ambientEvent = (
  session: SlackSession,
  subscription: TriggerSubscription,
  root: SlackMessage,
  revision: string,
  workContext: NonNullable<TriggerEvent["workContext"]>,
): TriggerEvent => ({
  key: {
    _tag: "SlackConversation",
    team: session.team,
    channel: root.channel,
    threadTs: rootTimestampOf(root),
  },
  revision,
  cause: { _tag: "Person" },
  atMillis: timestampMillis(revision),
  entry: subscription.entry,
  workspace: null,
  parameters: subscription.parameters,
  workContext,
});

const ambientEvents = Effect.fn("SlackSource.ambientEvents")(function* (
  client: SlackClientService,
  session: SlackSession,
  subscription: TriggerSubscription,
  now: number,
  emissions: Ref.Ref<ReadonlyMap<string, AmbientEmission>>,
  trackedRoots: Ref.Ref<ReadonlyMap<string, AmbientRoot>>,
) {
  const channel = parameterValue(subscription, "channel");
  if (!channel) return [];
  const since = catchUpSince(subscription, now);
  const [history, searched] = yield* Effect.all([
    client.history(session, channel, since),
    client.searchChannelMessages(session, channel, since),
  ]);
  const discovered = [...history, ...searched];
  const roots = yield* trackedAmbientRoots(subscription, channel, now, discovered, trackedRoots);
  return yield* Effect.forEach(roots, (root) =>
    Effect.gen(function* () {
      const { thread: complete } = yield* hydratedThread(client, session, root);
      const conversationRoot = complete.find((message) => message.ts === rootTimestampOf(root)) ?? root;
      const latestMillis = complete.reduce(
        (latest, message) => Math.max(latest, timestampMillis(message.ts)),
        timestampMillis(root.ts),
      );
      const rootKey = ambientEmissionKey(subscription, channel, rootTimestampOf(root));
      yield* Ref.update(trackedRoots, (current) => {
        const tracked = current.get(rootKey);
        return tracked ? new Map(current).set(rootKey, { ...tracked, latestMillis }) : current;
      });
      const author = parameterValue(subscription, "author") ?? "anyone";
      const relevant = complete.filter((message) => {
        const matchesAuthor = author !== "me" || message.user === session.user;
        const isRelevantMessage = !isCogworkMessage(message) && matchesAuthor;
        return isRelevantMessage;
      });
      const newest = relevant
        .toSorted((left, right) => timestampMillis(left.ts) - timestampMillis(right.ts))
        .at(-1);
      if (!newest || timestampMillis(newest.ts) <= since) return null;
      const quietFor = durationOf(subscription, "quiet-for", defaultQuietMillis);
      if (now - timestampMillis(newest.ts) < quietFor) return null;
      const key = ambientEmissionKey(subscription, channel, rootTimestampOf(root));
      const prior = (yield* Ref.get(emissions)).get(key);
      const priorAt = prior?.atMillis ?? 0;
      const atMostEvery = durationOf(subscription, "at-most-every", defaultAtMostMillis);
      if (prior?.revision === newest.ts || now - priorAt < atMostEvery) return null;
      const workContext = yield* resolvedWorkContext(
        client,
        session,
        conversationRoot,
        complete,
        "Slack conversation",
      );
      return ambientEvent(session, subscription, conversationRoot, newest.ts, workContext);
    }),
  ).pipe(Effect.map((events) => events.filter((event) => event !== null)));
});

const reactionEvents = Effect.fn("SlackSource.reactionEvents")(function* (
  client: SlackClientService,
  session: SlackSession,
  subscription: TriggerSubscription,
  now: number,
) {
  const since = catchUpSince(subscription, now);
  const emoji = parameterValue(subscription, "emoji");
  if (!emoji) return [];
  const messages = yield* client.reactions(session, since);
  return yield* Effect.forEach(messages, (message) =>
    Effect.gen(function* () {
      const matches = message.reactions.some((reaction) => {
        const isPersonsReaction = reaction.name === emoji && reaction.users.includes(session.user);
        return isPersonsReaction;
      });
      const isOutsideCatchUp = timestampMillis(message.ts) <= since;
      const shouldIgnore = !matches || isOutsideCatchUp;
      if (shouldIgnore) return null;
      const hydrated = yield* hydratedThread(client, session, message);
      if (isCogworkMessage(hydrated.selected)) return null;
      const workContext = yield* resolvedWorkContext(
        client,
        session,
        hydrated.selected,
        hydrated.thread,
        `Slack reaction :${emoji}:`,
      );
      return messageEvent(session, subscription, hydrated.selected, workContext);
    }),
  ).pipe(Effect.map((events) => events.filter((event) => event !== null)));
});

type EventReader = (
  client: SlackClientService,
  session: SlackSession,
  subscription: TriggerSubscription,
  now: number,
  emissions: Ref.Ref<ReadonlyMap<string, AmbientEmission>>,
  trackedRoots: Ref.Ref<ReadonlyMap<string, AmbientRoot>>,
) => Effect.Effect<ReadonlyArray<TriggerEvent>, SourceFailure>;

const eventReaders = {
  [mentionedKey]: ((client, session, subscription, now) =>
    mentionEvents(client, session, subscription, now)) satisfies EventReader,
  [ambientKey]: ambientEvents satisfies EventReader,
  [reactionKey]: ((client, session, subscription, now) =>
    reactionEvents(client, session, subscription, now)) satisfies EventReader,
} satisfies Readonly<Record<string, EventReader>>;

const availabilityFrom = (
  connectionExists: boolean,
  readiness: { readonly _tag: "Ready" } | { readonly _tag: "NotReady"; readonly reason: string } | null,
): WorkflowAvailability => {
  const availabilityRules: ReadonlyArray<{
    readonly matches: boolean;
    readonly value: WorkflowAvailability;
  }> = [
    { matches: !connectionExists, value: { _tag: "ConnectionNeeded" } },
    {
      matches: readiness?._tag === "NotReady",
      value: {
        _tag: "Unavailable",
        reason: readiness?._tag === "NotReady" ? readiness.reason : "Slack Connection unavailable",
      },
    },
  ];
  return availabilityRules.find(({ matches }) => matches)?.value ?? { _tag: "Available" };
};

export const make = Effect.gen(function* () {
  const client = yield* SlackClient;
  const connections = yield* ConnectionStore;
  const session = slackSession(connections);
  const emissions = yield* Ref.make<ReadonlyMap<string, AmbientEmission>>(new Map());
  const trackedRoots = yield* Ref.make<ReadonlyMap<string, AmbientRoot>>(new Map());

  const readEvents = Effect.fn("SlackSource.readEvents")(function* (
    subscriptions: ReadonlyArray<TriggerSubscription>,
    emissions: Ref.Ref<ReadonlyMap<string, AmbientEmission>>,
  ) {
    const connected = yield* session;
    const now = yield* Clock.currentTimeMillis;
    const nested = yield* Effect.forEach(subscriptions, (subscription) => {
      const reader = eventReaders[subscription.entry];
      return reader
        ? reader(client, connected, subscription, now, emissions, trackedRoots)
        : Effect.succeed([]);
    });
    return nested.flat();
  });

  const readers: SystemOptions["readers"] = {
    channel: () =>
      session.pipe(
        Effect.flatMap((connected) => client.channels(connected)),
        Effect.map((channels) =>
          channels.map(({ id: value, name }) => ({ value, name, listedIn: [] }) satisfies WorkflowOption),
        ),
      ),
    emoji: () =>
      session.pipe(
        Effect.flatMap((connected) => client.emojis(connected)),
        Effect.map((emojis) =>
          emojis.map((value) => ({ value, name: `:${value}:`, listedIn: [] }) satisfies WorkflowOption),
        ),
      ),
  };

  return {
    id: "slack",
    entries: slackEntries,
    availability: (_entry) =>
      connections.findSystem("slack").pipe(
        Effect.flatMap((connection) =>
          connection
            ? connections
                .readiness(connection.id)
                .pipe(Effect.map((readiness) => availabilityFrom(true, readiness)))
            : Effect.succeed(availabilityFrom(false, null)),
        ),
        Effect.orElseSucceed(
          () => ({ _tag: "Unavailable", reason: "Slack Connection unavailable" }) as const,
        ),
      ),
    options: [{ system: "slack", readers }],
    observe: (subscriptions) =>
      subscriptions.length === 0
        ? Stream.empty
        : Stream.unwrap(
            Clock.currentTimeMillis.pipe(
              Effect.map((startedAtMillis) => {
                const activeSubscriptions = subscriptions.map((subscription) =>
                  withCatchUpWindow(subscription, startedAtMillis),
                );
                return Stream.fromIterableEffect(readEvents(activeSubscriptions, emissions)).pipe(
                  Stream.repeat(pollSchedule),
                );
              }),
            ),
          ),
    acknowledge: (event, subscriptions) => {
      if (event.entry !== ambientKey || event.key._tag !== "SlackConversation") return Effect.void;
      const { channel, threadTs } = event.key;
      return Clock.currentTimeMillis.pipe(
        Effect.flatMap((atMillis) =>
          Ref.update(emissions, (current) =>
            subscriptions.reduce(
              (next, subscription) =>
                new Map(next).set(ambientEmissionKey(subscription, channel, threadTs), {
                  revision: event.revision,
                  atMillis,
                }),
              current,
            ),
          ),
        ),
      );
    },
  } satisfies TriggerSource;
});
