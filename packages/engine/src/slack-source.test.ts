import {
  Connection,
  connectionIdOf,
  WorkflowCatalogKey,
  WorkflowId,
  WorkflowNodeId,
} from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { ConnectionStore, type ConnectionStoreService } from "./connection";
import type { Credential } from "./credential-store";
import {
  make,
  makeHttpClient,
  SlackClient,
  type SlackClientService,
  type SlackMessage,
  type SlackSession,
} from "./slack-source";
import { SourceFailure, type TriggerSubscription } from "./trigger-source";

const decodeWorkflow = Schema.decodeSync(WorkflowId);
const decodeNode = Schema.decodeSync(WorkflowNodeId);
const decodeEntry = Schema.decodeSync(WorkflowCatalogKey);
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

const connectionStore: ConnectionStoreService = {
  overview: Effect.succeed({
    connections: [{ system: "slack", connection: slackConnection, readiness: { _tag: "Ready" } }],
  }),
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

const message = (input: Partial<SlackMessage> & Pick<SlackMessage, "ts" | "text">): SlackMessage => ({
  channel: "C123",
  threadTs: null,
  user: "U456",
  appId: null,
  metadata: null,
  reactions: [],
  ...input,
});

const mentioned = message({ ts: "90.000", text: "Could <@U123> review this?" });
const reply = message({
  ts: "91.000",
  threadTs: mentioned.ts,
  text: "I added the reproduction steps.",
  user: "U789",
});

interface SlackClientState {
  readonly search: ReadonlyArray<SlackMessage>;
  readonly history: ReadonlyArray<SlackMessage>;
  readonly reactions: ReadonlyArray<SlackMessage>;
  readonly replies: ReadonlyArray<SlackMessage>;
  readonly failure: SourceFailure | null;
}

class SlackClientStateRef extends Context.Service<SlackClientStateRef, Ref.Ref<SlackClientState>>()(
  "@cogwork/engine/slack-source.test/SlackClientStateRef",
) {
  static readonly layer = Layer.effect(
    SlackClientStateRef,
    Ref.make<SlackClientState>({
      search: [mentioned],
      history: [],
      reactions: [],
      replies: [mentioned, reply],
      failure: null,
    }),
  );
}

const clientLayer: Layer.Layer<SlackClient | SlackClientStateRef> = Layer.effect(
  SlackClient,
  Effect.map(SlackClientStateRef, (stateRef) => {
    const read = (select: (state: SlackClientState) => ReadonlyArray<SlackMessage>) =>
      Ref.get(stateRef).pipe(
        Effect.flatMap((state) => (state.failure ? state.failure : Effect.succeed(select(state)))),
      );
    return {
      searchMessages: () => read((state) => state.search),
      history: () => read((state) => state.history),
      reactions: () => read((state) => state.reactions),
      replies: () => read((state) => state.replies),
      channels: () => Effect.succeed([{ id: "C123", name: "reviews" }]),
      emojis: () => Effect.succeed(["eyes"]),
      channelName: () => Effect.succeed("reviews"),
      userName: (_session, user) => Effect.succeed(user === "U456" ? "Taylor" : "Morgan"),
      permalink: () => Effect.succeed("https://example.slack.com/archives/C123/p90000"),
    } satisfies SlackClientService;
  }),
).pipe(Layer.provideMerge(SlackClientStateRef.layer));

const subscription = (entry: string, parameters: TriggerSubscription["parameters"]): TriggerSubscription => ({
  workflow: decodeWorkflow("slack-review"),
  trigger: decodeNode("slack-trigger"),
  operation: decodeNode("review"),
  entry: decodeEntry(entry),
  parameters,
  workspaces: [],
  catchUp: { since: 0 },
});

const testLayer = Layer.mergeAll(Layer.succeed(ConnectionStore, connectionStore), clientLayer);

describe("Slack Trigger source", () => {
  it.effect("reports the Slack Connection refresh failure", () =>
    Effect.gen(function* () {
      const source = yield* make;
      const availability = yield* source.availability(decodeEntry("slack.i-am-mentioned"));

      assert.deepStrictEqual(availability, { _tag: "Unavailable", reason: "refresh failed" });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(ConnectionStore, {
            ...connectionStore,
            readiness: () => Effect.succeed({ _tag: "NotReady", reason: "refresh failed" }),
          }),
          clientLayer,
        ),
      ),
    ),
  );

  it.effect("emits a mention with its resolved thread frozen in Work context", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(100_000);
      const source = yield* make;
      const events = yield* source
        .observe([subscription("slack.i-am-mentioned", [])])
        .pipe(Stream.take(1), Stream.runCollect);
      const event = events[0];

      assert.deepStrictEqual(event?.key, {
        _tag: "SlackMessage",
        team: "T123",
        channel: "C123",
        ts: "90.000",
      });
      assert.strictEqual(event?.revision, "90.000");
      assert.include(event?.workContext?.body ?? "", "Taylor: Could <@U123> review this?");
      assert.include(event?.workContext?.body ?? "", "#reviews");
      assert.include(event?.workContext?.body ?? "", "https://example.slack.com/archives/C123/p90000");
      assert.deepStrictEqual(event?.workContext?.comments, [
        {
          author: "Morgan",
          authorAssociation: null,
          body: "I added the reproduction steps.",
          createdAtMillis: 91_000,
        },
      ]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("waits for a quiet conversation", () =>
    Effect.gen(function* () {
      const state = yield* SlackClientStateRef;
      const root = message({ ts: "950.000", text: "First message" });
      yield* Ref.set(state, {
        search: [],
        history: [root],
        reactions: [],
        replies: [root],
        failure: null,
      });
      yield* TestClock.setTime(1_000_000);
      const source = yield* make;
      const eventsFiber = yield* source
        .observe([
          subscription("slack.message-in-channel", [
            { id: "channel", value: "C123" },
            { id: "quiet-for", value: "300000" },
            { id: "at-most-every", value: "0" },
          ]),
        ])
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust("4 minutes");
      assert.isUndefined(eventsFiber.pollUnsafe());
      yield* TestClock.adjust("1 minute");
      const events = yield* Fiber.join(eventsFiber);

      assert.strictEqual(events[0]?.revision, "950.000");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("emits a changed conversation at most every configured interval", () =>
    Effect.gen(function* () {
      const state = yield* SlackClientStateRef;
      const root = message({ ts: "600.000", text: "First message" });
      yield* Ref.set(state, {
        search: [],
        history: [root],
        reactions: [],
        replies: [root],
        failure: null,
      });
      yield* TestClock.setTime(1_000_000);
      const source = yield* make;
      const firstEvent = yield* Deferred.make<void>();
      const eventsFiber = yield* source
        .observe([
          subscription("slack.message-in-channel", [
            { id: "channel", value: "C123" },
            { id: "quiet-for", value: "0" },
            { id: "at-most-every", value: "120000" },
          ]),
        ])
        .pipe(
          Stream.tap(() => Deferred.succeed(firstEvent, undefined)),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild({ startImmediately: true }),
        );
      yield* Deferred.await(firstEvent);
      yield* Ref.update(state, (current) => ({
        ...current,
        replies: [root, message({ ts: "1001.000", threadTs: root.ts, text: "Second message" })],
      }));
      assert.isUndefined(eventsFiber.pollUnsafe());
      yield* TestClock.adjust("1 minute");
      assert.isUndefined(eventsFiber.pollUnsafe());
      yield* TestClock.adjust("1 minute");
      const events = yield* Fiber.join(eventsFiber);

      assert.deepStrictEqual(
        events.map((event) => event.revision),
        ["600.000", "1001.000"],
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps a Cogwork post from moving an ambient revision", () =>
    Effect.gen(function* () {
      const root = message({ ts: "600.000", text: "Human message" });
      const cogwork = message({
        ts: "900.000",
        threadTs: root.ts,
        text: "Cogwork reply",
        appId: "A0CD4UYHKPX",
        metadata: { eventPayload: { write_key: "run-1:step-1" } },
      });
      yield* Ref.set(yield* SlackClientStateRef, {
        search: [],
        history: [root],
        reactions: [],
        replies: [root, cogwork],
        failure: null,
      });
      yield* TestClock.setTime(1_000_000);
      const source = yield* make;
      const events = yield* source
        .observe([
          subscription("slack.message-in-channel", [
            { id: "channel", value: "C123" },
            { id: "quiet-for", value: "0" },
            { id: "at-most-every", value: "0" },
          ]),
        ])
        .pipe(Stream.take(1), Stream.runCollect);

      assert.strictEqual(events[0]?.revision, "600.000");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("emits the person's reaction and leaves older reactions outside catch-up", () =>
    Effect.gen(function* () {
      const old = message({
        ts: "400.000",
        text: "Old",
        reactions: [{ name: "eyes", users: [session.user] }],
      });
      const reacted = message({
        ts: "900.000",
        text: "Review this",
        reactions: [{ name: "eyes", users: [session.user] }],
      });
      yield* Ref.set(yield* SlackClientStateRef, {
        search: [],
        history: [],
        reactions: [old, reacted],
        replies: [reacted],
        failure: null,
      });
      yield* TestClock.setTime(1_000_000);
      const source = yield* make;
      const events = yield* source
        .observe([
          {
            ...subscription("slack.reaction-added", [{ id: "emoji", value: "eyes" }]),
            catchUp: { since: 500_000 },
          },
        ])
        .pipe(Stream.take(1), Stream.runCollect);

      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0]?.revision, "900.000");
      assert.deepStrictEqual(events[0]?.key, {
        _tag: "SlackMessage",
        team: "T123",
        channel: "C123",
        ts: "900.000",
      });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("ends only the Slack stream with its Retry-After", () =>
    Effect.gen(function* () {
      yield* Ref.set(yield* SlackClientStateRef, {
        search: [],
        history: [],
        reactions: [],
        replies: [],
        failure: new SourceFailure({
          source: "slack",
          reason: "rate-limited",
          retryAfterMillis: 12_000,
          message: "Slack rate limited the request",
        }),
      });
      const source = yield* make;
      const failure = yield* Effect.flip(
        source.observe([subscription("slack.i-am-mentioned", [])]).pipe(Stream.runCollect),
      );

      assert.strictEqual(failure.reason, "rate-limited");
      assert.strictEqual(failure.retryAfterMillis, 12_000);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("reports Slack HTTP 429 Retry-After as milliseconds", () =>
    Effect.gen(function* () {
      const http = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify({ ok: false, error: "ratelimited" }), {
              status: 429,
              headers: { "content-type": "application/json", "retry-after": "12" },
            }),
          ),
        ),
      );
      const client = makeHttpClient(http);
      const failure = yield* Effect.flip(client.emojis(session));

      assert.strictEqual(failure.reason, "rate-limited");
      assert.strictEqual(failure.retryAfterMillis, 12_000);
    }),
  );

  it.effect("reads every Slack cursor page", () =>
    Effect.gen(function* () {
      const http = HttpClient.make((request, url) => {
        const cursor = url.searchParams.get("cursor");
        const response = cursor
          ? {
              ok: true,
              items: [
                {
                  type: "message",
                  channel: "C123",
                  message: { ts: "901.000", text: "Second page", reactions: [] },
                },
              ],
              response_metadata: { next_cursor: "" },
            }
          : {
              ok: true,
              items: [
                {
                  type: "message",
                  channel: "C123",
                  message: { ts: "900.000", text: "First page", reactions: [] },
                },
              ],
              response_metadata: { next_cursor: "next" },
            };
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify(response), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          ),
        );
      });

      const messages = yield* makeHttpClient(http).reactions(session, 0);

      assert.deepStrictEqual(
        messages.map(({ ts }) => ts),
        ["900.000", "901.000"],
      );
    }),
  );
});
