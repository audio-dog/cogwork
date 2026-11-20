import {
  Connection,
  type ConnectionReadiness,
  connectionIdOf,
  type ParkRecord,
  WorkflowCatalogKey,
} from "@cogwork/contracts";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import type { ConnectionStoreService } from "./connection";
import { CoordinationError, type CoordinationService, fold } from "./coordination";
import type { Credential } from "./credential-store";
import {
  type GranolaNoteSnapshot,
  type GranolaSourceAdapter,
  makeGranolaSource,
  makeGranolaSourceAdapters,
} from "./granola-source";
import { SourceFailure, type TriggerSubscription } from "./trigger-source";

const connectionId = connectionIdOf("granola", "person@example.com");
const connection = Connection.make({
  id: connectionId,
  system: "granola",
  account: "person@example.com",
  status: "established",
});
const generated = Schema.decodeSync(WorkflowCatalogKey)("granola.note-generated");
const edited = Schema.decodeSync(WorkflowCatalogKey)("granola.note-edited");
const subscription: TriggerSubscription = {
  workflow: Schema.decodeSync(Schema.String.pipe(Schema.brand("WorkflowId")))("granola-to-issue"),
  trigger: Schema.decodeSync(Schema.String.pipe(Schema.brand("WorkflowNodeId")))("note"),
  operation: Schema.decodeSync(Schema.String.pipe(Schema.brand("WorkflowNodeId")))("extract"),
  entry: generated,
  parameters: [],
  filters: [],
  workspaces: [],
  catchUp: { since: Date.parse("2026-10-28T00:00:00.000Z") },
};
const note: GranolaNoteSnapshot = {
  connection: connectionId,
  noteId: "note-1",
  updatedAt: "2026-10-29T15:00:00.000Z",
  updatedAtMillis: Date.parse("2026-10-29T15:00:00.000Z"),
  title: "Weekly product sync",
  attendees: ["Taylor <taylor@example.com>", "Ari <ari@example.com>"],
  calendarEvent: "Weekly product sync · 2026-10-29 09:00 MDT",
  summary: "Decided to ship the smaller change.",
  transcript: "Taylor: Ship the smaller change.\nAri: Agreed.",
};

const coordinationView = (revision: string | null, parks: ReadonlyArray<ParkRecord>) =>
  fold(
    {
      claim: null,
      attempts: [],
      handbacks: [],
      parks,
      revision: revision === null ? null : { observed: revision, processed: null },
    },
    "cogwork",
  );

const coordinationService = (
  revisionOf: (noteId: string) => string | null = () => null,
  planRejected: (noteId: string) => boolean = () => false,
): CoordinationService => ({
  fold,
  read: (ref) => {
    const noteId = ref._tag === "GranolaNote" ? ref.noteId : null;
    const revision = noteId === null ? null : revisionOf(noteId);
    const parks = (
      noteId !== null && planRejected(noteId)
        ? [
            {
              reason: {
                _tag: "PlanRejected",
                reason: "Granola note has no transcript",
                entry: generated,
              },
              atMillis: 1,
            },
          ]
        : []
    ) satisfies ReadonlyArray<ParkRecord>;
    return Effect.succeed(coordinationView(revision, parks));
  },
  claim: () => Effect.die("unused"),
  release: () => Effect.die("unused"),
  recordAttempt: () => Effect.die("unused"),
  park: (ref, reason) => {
    const noteId = ref._tag === "GranolaNote" ? ref.noteId : null;
    const revision = noteId === null ? null : revisionOf(noteId);
    if (revision === null) {
      return Effect.fail(
        new CoordinationError({
          reason: "refused",
          retryable: false,
          message: "source revision must be observed first",
        }),
      );
    }
    return Effect.succeed(coordinationView(revision, [{ reason, atMillis: 1 }]));
  },
  handBack: () => Effect.die("unused"),
  observe: () => Effect.die("unused"),
  markProcessed: () => Effect.die("unused"),
});

const credential = (source: Credential["source"]): Credential => ({
  source,
  token: Redacted.make("secret"),
  identity: null,
});

const connectionStore = (
  selected: Credential,
  readiness: ConnectionReadiness = { _tag: "Ready" },
): ConnectionStoreService => ({
  overview: Effect.succeed({ connections: [{ system: "granola", connection, readiness }] }),
  find: () => Effect.succeed(connection),
  findSystem: () => Effect.succeed(connection),
  bearer: () => Effect.succeed(selected),
  readiness: () => Effect.succeed(readiness),
  requireReady: () => Effect.void,
  requireSystemReady: () => Effect.void,
  establish: () => Effect.die("unused"),
  revoke: () => Effect.die("unused"),
  remove: () => Effect.die("unused"),
});

const adapter = (
  calls: Ref.Ref<number>,
  result: ReadonlyArray<GranolaNoteSnapshot>,
): GranolaSourceAdapter => ({
  read: () => Ref.update(calls, (count) => count + 1).pipe(Effect.map(() => result)),
});

const urlOf = (input: RequestInfo | URL) =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

const httpAdapters = (
  responses: ReadonlyArray<unknown>,
  urls: Ref.Ref<ReadonlyArray<string>>,
  bodies: Ref.Ref<ReadonlyArray<string>>,
) =>
  Effect.gen(function* () {
    const index = yield* Ref.make(0);
    const fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      return Effect.all({
        body: Effect.promise(() => request.clone().text()),
        response: Ref.modify(index, (current) => [responses[current], current + 1]),
      }).pipe(
        Effect.tap(({ body }) =>
          Effect.all(
            [
              Ref.update(urls, (current) => [...current, urlOf(input)]),
              Ref.update(bodies, (current) => [...current, body]),
            ],
            { discard: true },
          ),
        ),
        Effect.map(
          ({ response }) =>
            new Response(JSON.stringify(response), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
        ),
        Effect.runPromise,
      );
    };
    const context = yield* Layer.build(
      FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
    );
    return makeGranolaSourceAdapters(Context.get(context, HttpClient.HttpClient));
  });

it.effect("uses the API-key adapter and freezes a complete Granola note", () =>
  Effect.gen(function* () {
    const restCalls = yield* Ref.make(0);
    const mcpCalls = yield* Ref.make(0);
    const source = makeGranolaSource(
      connectionStore(credential("stored-key")),
      {
        rest: adapter(restCalls, [
          note,
          {
            ...note,
            noteId: "note-2",
            updatedAt: "2026-10-29T16:00:00.000Z",
            updatedAtMillis: Date.parse("2026-10-29T16:00:00.000Z"),
            summary: "Regenerated summary.",
          },
          { ...note, noteId: "note-3", transcript: null },
        ]),
        mcp: adapter(mcpCalls, [note]),
      },
      coordinationService((noteId) => (noteId === "note-2" ? "2026-10-29T15:00:00.000Z" : null)),
    );
    const events = yield* source
      .observe([subscription, { ...subscription, entry: edited }])
      .pipe(Stream.take(3), Stream.runCollect);

    assert.strictEqual(yield* Ref.get(restCalls), 1);
    assert.strictEqual(yield* Ref.get(mcpCalls), 0);
    assert.deepStrictEqual(events[0], {
      key: { _tag: "GranolaNote", connection: connectionId, noteId: "note-1" },
      revision: "2026-10-29T15:00:00.000Z",
      cause: { _tag: "Unknown" },
      atMillis: Date.parse("2026-10-29T15:00:00.000Z"),
      entry: generated,
      workspace: null,
      subject: { title: "Weekly product sync", url: null },
      payload: {
        _tag: "GranolaNote",
        title: "Weekly product sync",
        attendees: ["Taylor <taylor@example.com>", "Ari <ari@example.com>"],
        calendarEvent: "Weekly product sync · 2026-10-29 09:00 MDT",
        summary: "Decided to ship the smaller change.",
        transcript: "Taylor: Ship the smaller change.\nAri: Agreed.",
      },
    });
    assert.strictEqual(events[1]?.entry, edited);
    assert.strictEqual(events[1]?.revision, "2026-10-29T16:00:00.000Z");
    assert.strictEqual(
      events[1]?.payload?._tag === "GranolaNote" ? events[1].payload.summary : null,
      "Regenerated summary.",
    );
    assert.deepStrictEqual(events[2]?.payload, {
      _tag: "GranolaNoteRejected",
      reason: "Granola note has no transcript",
    });
  }),
);

it.effect("uses the MCP adapter when the Connection has no API key", () =>
  Effect.gen(function* () {
    const restCalls = yield* Ref.make(0);
    const mcpCalls = yield* Ref.make(0);
    const source = makeGranolaSource(
      connectionStore(credential("stored-oauth")),
      {
        rest: adapter(restCalls, [note]),
        mcp: adapter(mcpCalls, [note]),
      },
      coordinationService(),
    );
    yield* source.observe([subscription]).pipe(Stream.take(1), Stream.runDrain);

    assert.strictEqual(yield* Ref.get(restCalls), 0);
    assert.strictEqual(yield* Ref.get(mcpCalls), 1);
  }),
);

it.effect("classifies the first MCP note revision as generated", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const source = makeGranolaSource(
      connectionStore(credential("stored-oauth")),
      {
        rest: adapter(calls, []),
        mcp: adapter(calls, [note]),
      },
      coordinationService(),
    );
    const events = yield* source
      .observe([subscription, { ...subscription, entry: edited }])
      .pipe(Stream.take(1), Stream.runCollect);

    assert.strictEqual(events[0]?.entry, generated);
  }),
);

it.effect("classifies the first complete revision as generated after a plan rejection", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const source = makeGranolaSource(
      connectionStore(credential("stored-oauth")),
      {
        rest: adapter(calls, []),
        mcp: adapter(calls, [
          {
            ...note,
            updatedAt: "2026-10-29T16:00:00.000Z",
            updatedAtMillis: Date.parse("2026-10-29T16:00:00.000Z"),
          },
        ]),
      },
      coordinationService(
        () => "2026-10-29T15:00:00.000Z",
        () => true,
      ),
    );
    const events = yield* source
      .observe([subscription, { ...subscription, entry: edited }])
      .pipe(Stream.take(1), Stream.runCollect);

    assert.strictEqual(events[0]?.entry, generated);
  }),
);

it.effect("reports an unready Connection without reading either adapter", () =>
  Effect.gen(function* () {
    const restCalls = yield* Ref.make(0);
    const mcpCalls = yield* Ref.make(0);
    const readiness: ConnectionReadiness = { _tag: "NotReady", reason: "Granola login expired" };
    const source = makeGranolaSource(
      connectionStore(credential("stored-oauth"), readiness),
      {
        rest: adapter(restCalls, [note]),
        mcp: adapter(mcpCalls, [note]),
      },
      coordinationService(),
    );
    const availability = yield* source.availability(generated);
    const failure = yield* Effect.flip(source.observe([subscription]).pipe(Stream.runDrain));

    assert.deepStrictEqual(availability, { _tag: "Unavailable", reason: "Granola login expired" });
    assert.strictEqual(failure.reason, "connection-not-ready");
    assert.strictEqual(yield* Ref.get(restCalls), 0);
    assert.strictEqual(yield* Ref.get(mcpCalls), 0);
  }),
);

it.effect("reads every REST page after the supplied watermark", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-10-30T00:00:00.000Z"));
    const urls = yield* Ref.make<ReadonlyArray<string>>([]);
    const bodies = yield* Ref.make<ReadonlyArray<string>>([]);
    const adapters = yield* httpAdapters(
      [
        {
          data: [
            {
              id: "note-1",
              created_at: "2026-10-29T15:00:00.000Z",
              updated_at: "2026-10-29T15:00:00.000Z",
              title: "First",
              attendees: [{ name: "Taylor", email: "taylor@example.com" }],
              calendar_event: "First",
              summary_markdown: "First summary",
              transcript: [{ speaker: "Taylor", text: "First transcript" }],
            },
          ],
          has_more: true,
          next_cursor: "page-2",
        },
        {
          data: [
            {
              id: "note-2",
              created_at: "2026-10-29T16:00:00.000Z",
              updated_at: "2026-10-29T16:00:00.000Z",
              title: "Second",
              summary_markdown: "",
              summary_text: "Second summary",
              transcript: "Second transcript",
            },
          ],
          has_more: false,
          next_cursor: null,
        },
      ],
      urls,
      bodies,
    );
    const notes = yield* adapters.rest.read(
      credential("stored-key"),
      connectionId,
      Date.parse("2026-10-28T00:00:00.000Z"),
    );
    const requested = (yield* Ref.get(urls)).map((url) => new URL(url));

    assert.deepStrictEqual(
      notes.map(({ noteId }) => noteId),
      ["note-1", "note-2"],
    );
    assert.strictEqual(notes[1]?.summary, "Second summary");
    assert.strictEqual(requested[0]?.searchParams.get("updated_after"), "2026-10-28T00:00:00.000Z");
    assert.strictEqual(requested[1]?.searchParams.get("cursor"), "page-2");
  }),
);

it.effect("normalizes unusable REST transcripts to missing content", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-10-30T00:00:00.000Z"));
    const adapters = yield* httpAdapters(
      [
        {
          data: [
            {
              id: "blank-string",
              created_at: "2026-10-29T15:00:00.000Z",
              updated_at: "2026-10-29T15:00:00.000Z",
              title: "Blank string",
              transcript: " \n ",
            },
            {
              id: "blank-segment",
              created_at: "2026-10-29T16:00:00.000Z",
              updated_at: "2026-10-29T16:00:00.000Z",
              title: "Blank segment",
              transcript: [{ speaker: "Taylor", text: " " }],
            },
          ],
          has_more: false,
        },
      ],
      yield* Ref.make<ReadonlyArray<string>>([]),
      yield* Ref.make<ReadonlyArray<string>>([]),
    );
    const notes = yield* adapters.rest.read(
      credential("stored-key"),
      connectionId,
      subscription.catchUp?.since ?? 0,
    );

    assert.deepStrictEqual(
      notes.map(({ transcript }) => transcript),
      [null, null],
    );
  }),
);

it.effect("reads every MCP page and decodes its XML-like text", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-10-30T00:00:00.000Z"));
    const urls = yield* Ref.make<ReadonlyArray<string>>([]);
    const bodies = yield* Ref.make<ReadonlyArray<string>>([]);
    const response = (id: string, text: string) => ({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text }], isError: false },
    });
    const meeting = (
      id: string,
      title: string,
      updatedAt: string,
      summary = `<summary>${title} summary</summary>`,
    ) => `
      <meeting id="${id}" title="${title}" meeting_at="${updatedAt}" updated_at="${updatedAt}">
        <known_participants><participant name="Taylor" /></known_participants>
        <calendar_event>${title}</calendar_event>
        ${summary}
        <transcript>${title} transcript</transcript>
      </meeting>`;
    const adapters = yield* httpAdapters(
      [
        response(
          "first",
          `<meetings_data>${meeting("meeting-1", "Q3 Goals > Planning", "2026-10-29T15:00:00.000Z")}</meetings_data><pagination has_more="true" next_cursor="page-2" />`,
        ),
        response(
          "page-2",
          `<meetings_data>${meeting(
            "meeting-2",
            "Second",
            "2026-10-29T16:00:00.000Z",
            "<summary> </summary><summary_text>Second summary</summary_text>",
          )}</meetings_data><pagination has_more="false" />`,
        ),
      ],
      urls,
      bodies,
    );
    const notes = yield* adapters.mcp.read(
      credential("stored-oauth"),
      connectionId,
      Date.parse("2026-10-28T00:00:00.000Z"),
    );
    const requests = yield* Ref.get(bodies);

    assert.deepStrictEqual(
      notes.map(({ noteId, title }) => [noteId, title]),
      [
        ["meeting-1", "Q3 Goals > Planning"],
        ["meeting-2", "Second"],
      ],
    );
    assert.strictEqual(notes[1]?.summary, "Second summary");
    assert.include(requests[0] ?? "", '"updated_after":"2026-10-28T00:00:00.000Z"');
    assert.notInclude(requests[0] ?? "", "time_range");
    assert.include(requests[1] ?? "", '"cursor":"page-2"');
  }),
);

it.effect("rejects pages that promise another page without a cursor", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-10-30T00:00:00.000Z"));
    const urls = yield* Ref.make<ReadonlyArray<string>>([]);
    const bodies = yield* Ref.make<ReadonlyArray<string>>([]);
    const adapters = yield* httpAdapters(
      [
        { data: [], has_more: true },
        {
          jsonrpc: "2.0",
          id: "first",
          result: {
            content: [{ type: "text", text: '<meetings_data /><pagination has_more="true" />' }],
            isError: false,
          },
        },
      ],
      urls,
      bodies,
    );
    const rest = yield* Effect.result(
      adapters.rest.read(credential("stored-key"), connectionId, subscription.catchUp?.since ?? 0),
    );
    const mcp = yield* Effect.result(
      adapters.mcp.read(credential("stored-oauth"), connectionId, subscription.catchUp?.since ?? 0),
    );

    assert.deepStrictEqual([rest._tag, mcp._tag], ["Failure", "Failure"]);
    [rest, mcp].filter(Result.isFailure).forEach(({ failure }) => {
      assert.strictEqual(failure.reason, "decode");
      assert.include(failure.message, "pagination cursor");
    });
  }),
);

it.effect("advances the source watermark after a successful poll", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-10-30T00:00:00.000Z"));
    const calls = yield* Ref.make(0);
    const watermarks = yield* Ref.make<ReadonlyArray<number>>([]);
    const progressive: GranolaSourceAdapter = {
      read: (_credential, _connection, watermark) =>
        Ref.modify(calls, (count) => [count, count + 1]).pipe(
          Effect.tap(() => Ref.update(watermarks, (current) => [...current, watermark])),
          Effect.flatMap((count) =>
            count === 0
              ? Effect.succeed([note])
              : Effect.fail(
                  new SourceFailure({
                    source: "granola",
                    reason: "unavailable",
                    retryAfterMillis: null,
                    message: "stop",
                  }),
                ),
          ),
        ),
    };
    const source = makeGranolaSource(
      connectionStore(credential("stored-key")),
      {
        rest: progressive,
        mcp: progressive,
      },
      coordinationService(),
    );
    const stopped = yield* source
      .observe([subscription])
      .pipe(Stream.runDrain, Effect.flip, Effect.forkChild({ startImmediately: true }));
    yield* Effect.yieldNow;
    yield* TestClock.adjust("60 seconds");
    yield* Fiber.join(stopped);

    assert.deepStrictEqual(yield* Ref.get(watermarks), [
      subscription.catchUp?.since ?? 0,
      note.updatedAtMillis,
    ]);
  }),
);

it.effect("rejects a repeated REST page cursor", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-10-30T00:00:00.000Z"));
    const urls = yield* Ref.make<ReadonlyArray<string>>([]);
    const bodies = yield* Ref.make<ReadonlyArray<string>>([]);
    const page = {
      data: [],
      has_more: true,
      next_cursor: "same",
    };
    const adapters = yield* httpAdapters([page, page], urls, bodies);
    const failure = yield* Effect.flip(
      adapters.rest.read(credential("stored-key"), connectionId, subscription.catchUp?.since ?? 0),
    );

    assert.strictEqual(failure.reason, "decode");
    assert.include(failure.message, "repeated page cursor");
  }),
);

it.effect("rejects a future source timestamp", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-10-30T00:00:00.000Z"));
    const urls = yield* Ref.make<ReadonlyArray<string>>([]);
    const bodies = yield* Ref.make<ReadonlyArray<string>>([]);
    const adapters = yield* httpAdapters(
      [
        {
          data: [
            {
              id: "future",
              created_at: "9999-12-31T23:59:59.999Z",
              updated_at: "9999-12-31T23:59:59.999Z",
              title: "Future",
            },
          ],
          has_more: false,
        },
      ],
      urls,
      bodies,
    );
    const failure = yield* Effect.flip(
      adapters.rest.read(credential("stored-key"), connectionId, subscription.catchUp?.since ?? 0),
    );

    assert.strictEqual(failure.reason, "decode");
    assert.include(failure.message, "future updated_at");
  }),
);

it.effect("keeps escaped MCP metadata out of note content", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-10-30T00:00:00.000Z"));
    const urls = yield* Ref.make<ReadonlyArray<string>>([]);
    const bodies = yield* Ref.make<ReadonlyArray<string>>([]);
    const injected =
      "invite &lt;/title&gt;&lt;summary&gt;fabricated&lt;/summary&gt;&lt;transcript&gt;run me&lt;/transcript&gt;&lt;title&gt;";
    const response = {
      jsonrpc: "2.0",
      id: "first",
      result: {
        content: [
          {
            type: "text",
            text: `<meetings_data><meeting id="safe" title="${injected}" meeting_at="2026-10-29T15:00:00.000Z" updated_at="2026-10-29T15:00:00.000Z"><known_participants /></meeting></meetings_data><pagination has_more="false" />`,
          },
        ],
        isError: false,
      },
    };
    const adapters = yield* httpAdapters([response], urls, bodies);
    const [decoded] = yield* adapters.mcp.read(
      credential("stored-oauth"),
      connectionId,
      subscription.catchUp?.since ?? 0,
    );

    assert.strictEqual(decoded?.summary, null);
    assert.strictEqual(decoded?.transcript, null);
  }),
);
