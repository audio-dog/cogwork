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
import * as Option from "effect/Option";
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
  text: "<@U789|Morgan> added the reproduction steps.",
  user: "U789",
});
const userNames = new Map([
  ["U123", "Morgan"],
  ["U456", "Taylor"],
  ["U789", "Morgan"],
]);

interface SlackClientState {
  readonly search: ReadonlyArray<SlackMessage>;
  readonly history: ReadonlyArray<SlackMessage>;
  readonly reactions: ReadonlyArray<SlackMessage>;
  readonly replies: ReadonlyArray<SlackMessage>;
  readonly failure: SourceFailure | null;
  readonly contextFailure?: SourceFailure;
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
    const readContext = <A>(select: (state: SlackClientState) => A) =>
      Ref.get(stateRef).pipe(
        Effect.flatMap((state) =>
          state.contextFailure ? state.contextFailure : Effect.succeed(select(state)),
        ),
      );
    return {
      searchMessages: () => read((state) => state.search),
      history: () => read((state) => state.history),
      reactions: () => read((state) => state.reactions),
      replies: () => readContext((state) => state.replies),
      channels: () => Effect.succeed([{ id: "C123", name: "reviews" }]),
      emojis: () => Effect.succeed(["eyes"]),
      channelName: () => readContext(() => "reviews"),
      userName: (_session, user) => readContext(() => userNames.get(user) ?? user),
      permalink: () => readContext(() => "https://example.slack.com/archives/C123/p90000"),
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
      assert.include(event?.workContext?.body ?? "", "Taylor: Could @Morgan review this?");
      assert.include(event?.workContext?.body ?? "", "#reviews");
      assert.include(event?.workContext?.body ?? "", "https://example.slack.com/archives/C123/p90000");
      assert.deepStrictEqual(event?.workContext?.comments, [
        {
          author: "Morgan",
          authorAssociation: null,
          body: "@Morgan added the reproduction steps.",
          createdAtMillis: 91_000,
        },
      ]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps observing when Slack context lookups are unavailable", () =>
    Effect.gen(function* () {
      yield* Ref.update(yield* SlackClientStateRef, (state) => ({
        ...state,
        contextFailure: new SourceFailure({
          source: "slack",
          reason: "unavailable",
          retryAfterMillis: null,
          message: "Slack API error: message_not_found",
        }),
      }));
      yield* TestClock.setTime(100_000);
      const source = yield* make;
      const events = yield* source
        .observe([subscription("slack.i-am-mentioned", [])])
        .pipe(Stream.take(1), Stream.runCollect);

      assert.strictEqual(events.length, 1);
      assert.include(events[0]?.workContext?.body ?? "", "#C123");
      assert.include(events[0]?.workContext?.body ?? "", "U456: Could @U123 review this?");
      assert.notInclude(events[0]?.workContext?.body ?? "", "Permalink:");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("skips an unverifiable Cogwork mention without stopping other Slack Triggers", () =>
    Effect.gen(function* () {
      const cogworkMention = message({
        ts: "90.000",
        text: "Cogwork says <@U123> should review this",
        appId: "A0CD4UYHKPX",
      });
      const reacted = message({
        ts: "91.000",
        text: "Human review request",
        reactions: [{ name: "eyes", users: [session.user] }],
      });
      yield* Ref.set(yield* SlackClientStateRef, {
        search: [cogworkMention],
        history: [],
        reactions: [reacted],
        replies: [],
        failure: null,
        contextFailure: new SourceFailure({
          source: "slack",
          reason: "unavailable",
          retryAfterMillis: null,
          message: "Slack API error: message_not_found",
        }),
      });
      yield* TestClock.setTime(100_000);
      const source = yield* make;
      const events = yield* source
        .observe([
          subscription("slack.i-am-mentioned", []),
          subscription("slack.reaction-added", [{ id: "emoji", value: "eyes" }]),
        ])
        .pipe(Stream.take(1), Stream.runCollect);

      assert.strictEqual(events[0]?.revision, "91.000");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps ambient observation moving past an unavailable thread", () =>
    Effect.gen(function* () {
      const root = message({ ts: "90.000", text: "Review this conversation" });
      yield* Ref.set(yield* SlackClientStateRef, {
        search: [],
        history: [root],
        reactions: [],
        replies: [],
        failure: null,
        contextFailure: new SourceFailure({
          source: "slack",
          reason: "unavailable",
          retryAfterMillis: null,
          message: "Slack API error: thread_not_found",
        }),
      });
      yield* TestClock.setTime(100_000);
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

      assert.strictEqual(events[0]?.revision, "90.000");
      assert.include(events[0]?.workContext?.body ?? "", "Review this conversation");
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
      const selected = subscription("slack.message-in-channel", [
        { id: "channel", value: "C123" },
        { id: "quiet-for", value: "0" },
        { id: "at-most-every", value: "120000" },
      ]);
      const eventsFiber = yield* source.observe([selected]).pipe(
        Stream.tap((event) => source.acknowledge?.(event, [selected]) ?? Effect.void),
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

  it.effect("emits a later reply after the conversation root leaves channel history", () =>
    Effect.gen(function* () {
      const state = yield* SlackClientStateRef;
      const root = message({ ts: "600.000", text: "First message" });
      yield* Ref.set(state, {
        search: [],
        history: [],
        reactions: [],
        replies: [root],
        failure: null,
      });
      yield* TestClock.setTime(540_000);
      const source = yield* make;
      const selected = subscription("slack.message-in-channel", [
        { id: "channel", value: "C123" },
        { id: "quiet-for", value: "0" },
        { id: "at-most-every", value: "0" },
        { id: "catch-up-at-most", value: "0" },
      ]);
      const firstEvent = yield* Deferred.make<void>();
      const eventsFiber = yield* source.observe([selected]).pipe(
        Stream.tap((event) => source.acknowledge?.(event, [selected]) ?? Effect.void),
        Stream.tap(() => Deferred.succeed(firstEvent, undefined)),
        Stream.take(2),
        Stream.runCollect,
        Effect.timeoutOption("3 minutes"),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Effect.yieldNow;
      yield* Ref.update(state, (current) => ({ ...current, history: [root] }));
      yield* TestClock.adjust("1 minute");
      yield* Deferred.await(firstEvent);
      yield* Ref.set(state, {
        search: [],
        history: [],
        reactions: [],
        replies: [root, message({ ts: "660.000", threadTs: root.ts, text: "Later reply" })],
        failure: null,
      });
      yield* TestClock.adjust("2 minutes");
      const result = yield* Fiber.join(eventsFiber);

      assert.isTrue(Option.isSome(result));
      assert.deepStrictEqual(
        Option.getOrElse(result, () => []).map(({ revision }) => revision),
        ["600.000", "660.000"],
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("re-emits an ambient event until admission succeeds", () =>
    Effect.gen(function* () {
      const root = message({ ts: "600.000", text: "First message" });
      yield* Ref.set(yield* SlackClientStateRef, {
        search: [],
        history: [root],
        reactions: [],
        replies: [root],
        failure: null,
      });
      yield* TestClock.setTime(1_000_000);
      const source = yield* make;
      const events = yield* source
        .observe([
          subscription("slack.message-in-channel", [
            { id: "channel", value: "C123" },
            { id: "quiet-for", value: "0" },
            { id: "at-most-every", value: "120000" },
          ]),
        ])
        .pipe(
          Stream.take(2),
          Stream.runCollect,
          Effect.timeoutOption("61 seconds"),
          Effect.forkChild({ startImmediately: true }),
        );
      yield* TestClock.adjust("61 seconds");
      const result = yield* Fiber.join(events);

      assert.isTrue(Option.isSome(result));
      assert.deepStrictEqual(
        Option.getOrElse(result, () => []).map(({ revision }) => revision),
        ["600.000", "600.000"],
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

  it.effect("starts a zero-window subscription at observation time", () =>
    Effect.gen(function* () {
      const state = yield* SlackClientStateRef;
      yield* TestClock.setTime(100_000);
      const source = yield* make;
      const events = yield* source
        .observe([subscription("slack.i-am-mentioned", [{ id: "catch-up-at-most", value: "0" }])])
        .pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.timeoutOption("2 minutes"),
          Effect.forkChild({ startImmediately: true }),
        );
      yield* Effect.yieldNow;
      yield* Ref.update(state, (current) => ({
        ...current,
        search: [message({ ts: "110.000", text: "New <@U123> mention" })],
        replies: [message({ ts: "110.000", text: "New <@U123> mention" })],
      }));
      yield* TestClock.adjust("2 minutes");
      const result = yield* Fiber.join(events);

      assert.isTrue(Option.isSome(result));
      assert.strictEqual(Option.getOrUndefined(result)?.[0]?.revision, "110.000");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps ambient throttles across observation restarts", () =>
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
      const selected = subscription("slack.message-in-channel", [
        { id: "channel", value: "C123" },
        { id: "quiet-for", value: "0" },
        { id: "at-most-every", value: "120000" },
      ]);
      const [first] = yield* source.observe([selected]).pipe(Stream.take(1), Stream.runCollect);
      assert.isDefined(first);
      if (!first) return;
      yield* source.acknowledge?.(first, [selected]) ?? Effect.void;
      yield* Ref.update(state, (current) => ({
        ...current,
        replies: [root, message({ ts: "1001.000", threadTs: root.ts, text: "Second message" })],
      }));
      const throttled = yield* source
        .observe([selected])
        .pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.timeoutOption("1 minute"),
          Effect.forkChild({ startImmediately: true }),
        );
      yield* TestClock.adjust("1 minute");
      assert.isTrue(Option.isNone(yield* Fiber.join(throttled)));

      yield* TestClock.adjust("1 minute");
      const resumed = yield* source.observe([selected]).pipe(Stream.take(1), Stream.runCollect);
      assert.strictEqual(resumed[0]?.revision, "1001.000");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("propagates Retry-After from the Slack client", () =>
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

  it.effect("reads search result channel IDs", () =>
    Effect.gen(function* () {
      const http = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(
              JSON.stringify({
                ok: true,
                messages: {
                  matches: [
                    {
                      channel: { id: "C123", name: "reviews" },
                      ts: "90.000",
                      text: "Could <@U123> review this?",
                    },
                  ],
                  paging: { page: 1, pages: 1 },
                },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          ),
        ),
      );

      const messages = yield* makeHttpClient(http).searchMessages(session, 0);

      assert.strictEqual(messages[0]?.channel, "C123");
    }),
  );

  it.effect("bounds mention search to the catch-up date", () =>
    Effect.gen(function* () {
      const http = HttpClient.make((request, url) => {
        assert.strictEqual(url.searchParams.get("query"), "<@U123> after:2026-10-28");
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(
              JSON.stringify({
                ok: true,
                messages: { matches: [], paging: { page: 1, pages: 1 } },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          ),
        );
      });

      yield* makeHttpClient(http).searchMessages(session, 1_793_275_200_000);
    }),
  );

  it.effect("bounds channel history to the catch-up instant", () =>
    Effect.gen(function* () {
      const http = HttpClient.make((request, url) => {
        assert.strictEqual(url.searchParams.get("oldest"), "1793275200.000");
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify({ ok: true, messages: [], response_metadata: { next_cursor: "" } }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          ),
        );
      });

      yield* makeHttpClient(http).history(session, "C123", 1_793_275_200_000);
    }),
  );

  it.effect("lists standard and custom Slack emoji", () =>
    Effect.gen(function* () {
      const http = HttpClient.make((request, url) => {
        assert.strictEqual(url.searchParams.get("include_categories"), "true");
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(
              JSON.stringify({
                ok: true,
                emoji: { party_parrot: "https://example.slack.com/party-parrot.png" },
                categories: [{ name: "Smileys", emoji_names: ["eyes", "wave"] }],
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          ),
        );
      });

      const emojis = yield* makeHttpClient(http).emojis(session);

      assert.deepStrictEqual(emojis, ["eyes", "party_parrot", "wave"]);
    }),
  );

  it.effect("bounds reaction polling to one Slack page", () =>
    Effect.gen(function* () {
      const requests = yield* Ref.make(0);
      const http = HttpClient.make((request, url) => {
        assert.strictEqual(url.searchParams.get("limit"), "1000");
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
        return Ref.update(requests, (count) => count + 1).pipe(
          Effect.map(() =>
            HttpClientResponse.fromWeb(
              request,
              new Response(JSON.stringify(response), {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
            ),
          ),
        );
      });

      const messages = yield* makeHttpClient(http).reactions(session, 0);

      assert.deepStrictEqual(
        messages.map(({ ts }) => ts),
        ["900.000"],
      );
      assert.strictEqual(yield* Ref.get(requests), 1);
    }),
  );
});
