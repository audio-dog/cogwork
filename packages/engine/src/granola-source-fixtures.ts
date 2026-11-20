import {
  Connection,
  type ConnectionReadiness,
  connectionIdOf,
  type ParkRecord,
  WorkflowCatalogKey,
} from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type { ConnectionStoreService } from "./connection";
import { CoordinationError, type CoordinationService, fold } from "./coordination";
import type { Credential } from "./credential-store";
import {
  type GranolaNoteSnapshot,
  type GranolaSourceAdapter,
  makeGranolaSourceAdapters,
} from "./granola-source";
import type { TriggerSubscription } from "./trigger-source";

export const connectionId = connectionIdOf("granola", "person@example.com");
export const connection = Connection.make({
  id: connectionId,
  system: "granola",
  account: "person@example.com",
  status: "established",
});
export const generated = Schema.decodeSync(WorkflowCatalogKey)("granola.note-generated");
export const edited = Schema.decodeSync(WorkflowCatalogKey)("granola.note-edited");
export const subscription: TriggerSubscription = {
  workflow: Schema.decodeSync(Schema.String.pipe(Schema.brand("WorkflowId")))("granola-to-issue"),
  trigger: Schema.decodeSync(Schema.String.pipe(Schema.brand("WorkflowNodeId")))("note"),
  operation: Schema.decodeSync(Schema.String.pipe(Schema.brand("WorkflowNodeId")))("extract"),
  entry: generated,
  parameters: [],
  filters: [],
  workspaces: [],
  catchUp: { since: Date.parse("2026-10-28T00:00:00.000Z") },
};
export const note: GranolaNoteSnapshot = {
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
    0,
  );

export const coordinationService = (
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

export const credential = (source: Credential["source"]): Credential => ({
  source,
  token: Redacted.make("secret"),
  identity: null,
});

export const connectionStore = (
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

export const adapter = (
  calls: Ref.Ref<number>,
  result: ReadonlyArray<GranolaNoteSnapshot>,
): GranolaSourceAdapter => ({
  read: () => Ref.update(calls, (count) => count + 1).pipe(Effect.map(() => result)),
});

const urlOf = (input: RequestInfo | URL) =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

export const httpAdapters = (
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
