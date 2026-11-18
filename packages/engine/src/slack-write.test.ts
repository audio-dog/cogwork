import {
  Connection,
  connectionIdOf,
  SlackChannelId,
  SlackWriteKey,
  WorkflowActionTarget,
} from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import type { ConnectionStoreService } from "./connection";
import type { Credential } from "./credential-store";
import type { SlackMessage, SlackSession } from "./slack-source";
import { make } from "./slack-write";

const slackConnection = Connection.make({
  id: connectionIdOf("slack", "T123"),
  system: "slack",
  account: "T123",
  status: "established",
});
const session: SlackSession = {
  team: "T123",
  user: "U123",
  token: Redacted.make("xoxp-test"),
};
const channelId = Schema.decodeSync(SlackChannelId);
const writeKey = Schema.decodeSync(SlackWriteKey);
const messageTarget = (channel: string, ts: string, threadTs: string) => {
  const target = Schema.decodeSync(WorkflowActionTarget)({
    _tag: "SlackMessage",
    team: session.team,
    channel,
    ts,
    threadTs,
  });
  if (!WorkflowActionTarget.guards.SlackMessage(target)) throw new Error("expected Slack message target");
  return target;
};
const connections: ConnectionStoreService = {
  overview: Effect.die("unused"),
  find: () => Effect.succeed(slackConnection),
  findSystem: () => Effect.succeed(slackConnection),
  bearer: () =>
    Effect.succeed({
      source: "stored-oauth",
      token: session.token,
      identity: { organization: session.team, actorUserId: session.user },
    } satisfies Credential),
  readiness: () => Effect.succeed({ _tag: "Ready" }),
  requireReady: () => Effect.void,
  requireSystemReady: () => Effect.void,
  establish: () => Effect.die("unused"),
  revoke: () => Effect.die("unused"),
  remove: () => Effect.die("unused"),
};

const PostBody = Schema.Struct({
  channel: Schema.String,
  text: Schema.String,
  thread_ts: Schema.optional(Schema.String),
  metadata: Schema.Struct({
    event_type: Schema.Literal("cogwork_write"),
    event_payload: Schema.Struct({ write_key: Schema.String }),
  }),
});

const ReactionBody = Schema.Struct({
  channel: Schema.String,
  timestamp: Schema.String,
  name: Schema.String,
});

const DraftBody = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.String,
  method: Schema.Literal("tools/call"),
  params: Schema.Struct({
    name: Schema.Literal("slack_send_message_draft"),
    arguments: Schema.Struct({
      channel_id: Schema.String,
      message: Schema.String,
      thread_ts: Schema.optional(Schema.String),
    }),
  }),
});

const requestJson = (request: HttpClientRequest.HttpClientRequest) => {
  assert.strictEqual(request.body._tag, "Uint8Array");
  if (request.body._tag !== "Uint8Array") throw new Error("expected JSON request body");
  const value: unknown = JSON.parse(new TextDecoder().decode(request.body.body));
  return value;
};

const response = (request: HttpClientRequest.HttpClientRequest, body: unknown, status = 200) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...(status === 429 ? { "retry-after": "12" } : {}) },
    }),
  );

interface SlackState {
  readonly history: ReadonlyArray<SlackMessage>;
  readonly replies: ReadonlyArray<SlackMessage>;
}

const slackClient = (state: Ref.Ref<SlackState>) => ({
  findWrite: (
    _session: SlackSession,
    lookup: { readonly threadTs: string | null; readonly writeKey: string },
  ) =>
    Ref.get(state).pipe(
      Effect.map((current) => {
        const messages = lookup.threadTs ? current.replies : current.history;
        return (
          messages.find(
            ({ metadata }) =>
              metadata?.eventType === "cogwork_write" && metadata.writeKey === lookup.writeKey,
          ) ?? null
        );
      }),
    ),
});

describe("Slack write port", () => {
  it.effect("reads post write keys back before sending a retry", () =>
    Effect.gen(function* () {
      const state = yield* Ref.make<SlackState>({ history: [], replies: [] });
      const posts = yield* Ref.make<ReadonlyArray<typeof PostBody.Type>>([]);
      const http = HttpClient.make((request, url) => {
        assert.strictEqual(url.pathname, "/api/chat.postMessage");
        const body = Schema.decodeUnknownSync(PostBody)(requestJson(request));
        const ts = body.thread_ts ? "902.000" : "901.000";
        const posted: SlackMessage = {
          channel: body.channel,
          ts,
          threadTs: body.thread_ts ?? null,
          text: body.text,
          user: session.user,
          appId: "A0CD4UYHKPX",
          metadata: { eventType: body.metadata.event_type, writeKey: body.metadata.event_payload.write_key },
          reactions: [],
        };
        return Ref.update(posts, (current) => [...current, body]).pipe(
          Effect.andThen(
            Ref.update(state, (current) =>
              body.thread_ts
                ? { ...current, replies: [...current.replies, posted] }
                : { ...current, history: [...current.history, posted] },
            ),
          ),
          Effect.map(() => response(request, { ok: true, channel: body.channel, ts })),
        );
      });
      const slack = make(slackClient(state), http, connections);
      const item = messageTarget("C123", "900.000", "900.000");

      const sent = yield* slack.sendMessage(channelId("C456"), "Hello", writeKey("send-key"));
      const retriedSend = yield* slack.sendMessage(channelId("C456"), "Hello", writeKey("send-key"));
      const replied = yield* slack.replyInThread(item, "On it", writeKey("reply-key"));
      const retriedReply = yield* slack.replyInThread(item, "On it", writeKey("reply-key"));

      assert.strictEqual((yield* Ref.get(posts)).length, 2);
      assert.strictEqual(sent.ts, "901.000");
      assert.strictEqual(retriedSend.ts, "901.000");
      assert.strictEqual(replied.ts, "902.000");
      assert.strictEqual(retriedReply.ts, "902.000");
    }),
  );

  it.effect("treats already_reacted as complete and sends the emoji name", () =>
    Effect.gen(function* () {
      const state = yield* Ref.make<SlackState>({ history: [], replies: [] });
      const reactions = yield* Ref.make<ReadonlyArray<typeof ReactionBody.Type>>([]);
      const http = HttpClient.make((request, url) => {
        assert.strictEqual(url.pathname, "/api/reactions.add");
        const body = Schema.decodeUnknownSync(ReactionBody)(requestJson(request));
        return Ref.update(reactions, (current) => [...current, body]).pipe(
          Effect.map(() => response(request, { ok: false, error: "already_reacted" })),
        );
      });
      const slack = make(slackClient(state), http, connections);

      const result = yield* Effect.exit(
        slack.addReaction(messageTarget("C123", "900.000", "900.000"), "eyes"),
      );

      assert.strictEqual(result._tag, "Success");
      assert.deepStrictEqual(yield* Ref.get(reactions), [
        { channel: "C123", timestamp: "900.000", name: "eyes" },
      ]);
    }),
  );

  it.effect("returns a retryable write failure for Slack 429", () =>
    Effect.gen(function* () {
      const state = yield* Ref.make<SlackState>({ history: [], replies: [] });
      const http = HttpClient.make((request) =>
        Effect.succeed(response(request, { ok: false, error: "ratelimited" }, 429)),
      );
      const slack = make(slackClient(state), http, connections);

      const failure = yield* Effect.flip(
        slack.sendMessage(channelId("C123"), "Hello", writeKey("write-key")),
      );

      assert.strictEqual(failure.reason, "rate-limited");
      assert.isTrue(failure.retryable);
    }),
  );

  it.effect("times out a stalled post response body", () =>
    Effect.gen(function* () {
      const state = yield* Ref.make<SlackState>({ history: [], replies: [] });
      const slack = make(
        slackClient(state),
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(new ReadableStream({ start() {} }), {
                headers: { "content-type": "application/json" },
              }),
            ),
          ),
        ),
        connections,
      );
      const pending = yield* Effect.flip(
        slack.sendMessage(channelId("C123"), "Hello", writeKey("write-key")),
      ).pipe(Effect.forkChild({ startImmediately: true }));

      yield* TestClock.adjust("30 seconds");
      const failure = yield* Fiber.join(pending);

      assert.strictEqual(failure.reason, "unavailable");
      assert.isTrue(failure.retryable);
    }),
  );

  it.effect("calls the Slack Plugin draft tool with the item's thread", () =>
    Effect.gen(function* () {
      const state = yield* Ref.make<SlackState>({ history: [], replies: [] });
      const drafts = yield* Ref.make<ReadonlyArray<typeof DraftBody.Type>>([]);
      const http = HttpClient.make((request, url) => {
        assert.strictEqual(url.toString(), "https://mcp.slack.com/mcp");
        const body = Schema.decodeUnknownSync(DraftBody)(requestJson(request));
        return Ref.update(drafts, (current) => [...current, body]).pipe(
          Effect.map(() => {
            const result = {
              jsonrpc: "2.0",
              id: body.id,
              result: { content: [{ type: "text", text: "Draft created" }] },
            };
            return HttpClientResponse.fromWeb(
              request,
              new Response(`data: ${JSON.stringify(result)}\n\n`, {
                headers: { "content-type": "text/event-stream" },
              }),
            );
          }),
        );
      });
      const slack = make(slackClient(state), http, connections);

      const result = yield* Effect.exit(
        slack.draftReply(messageTarget("C123", "902.000", "900.000"), "Looks good"),
      );

      assert.strictEqual(result._tag, "Success");
      assert.deepNestedInclude((yield* Ref.get(drafts))[0], {
        params: {
          name: "slack_send_message_draft",
          arguments: { channel_id: "C123", message: "Looks good", thread_ts: "900.000" },
        },
      });
    }),
  );

  it.effect("classifies a draft error response as a known permanent failure", () =>
    Effect.gen(function* () {
      const state = yield* Ref.make<SlackState>({ history: [], replies: [] });
      const http = HttpClient.make((request) =>
        Effect.succeed(
          response(request, {
            jsonrpc: "2.0",
            id: "draft",
            error: { code: -32_602, message: "Draft rejected" },
          }),
        ),
      );
      const slack = make(slackClient(state), http, connections);

      const failure = yield* Effect.flip(
        slack.draftReply(messageTarget("C123", "902.000", "900.000"), "Looks good"),
      );

      assert.strictEqual(failure.reason, "invalid");
      assert.isFalse(failure.retryable);
    }),
  );

  it.effect("classifies a draft server failure as an unknown outcome", () =>
    Effect.gen(function* () {
      const state = yield* Ref.make<SlackState>({ history: [], replies: [] });
      const http = HttpClient.make((request) =>
        Effect.succeed(response(request, { error: "server failure" }, 500)),
      );
      const slack = make(slackClient(state), http, connections);

      const failure = yield* Effect.flip(
        slack.draftReply(messageTarget("C123", "902.000", "900.000"), "Looks good"),
      );

      assert.strictEqual(failure.reason, "draft-outcome-unknown");
      assert.isFalse(failure.retryable);
    }),
  );

  it.effect("classifies a stalled draft body as an unknown outcome", () =>
    Effect.gen(function* () {
      const state = yield* Ref.make<SlackState>({ history: [], replies: [] });
      const slack = make(
        slackClient(state),
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(new ReadableStream({ start() {} }), {
                headers: { "content-type": "application/json" },
              }),
            ),
          ),
        ),
        connections,
      );
      const pending = yield* Effect.flip(
        slack.draftReply(messageTarget("C123", "902.000", "900.000"), "Looks good"),
      ).pipe(Effect.forkChild({ startImmediately: true }));

      yield* TestClock.adjust("30 seconds");
      const failure = yield* Fiber.join(pending);

      assert.strictEqual(failure.reason, "draft-outcome-unknown");
      assert.isFalse(failure.retryable);
    }),
  );
});
