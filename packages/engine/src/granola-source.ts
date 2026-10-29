import {
  type ConnectionId,
  ParkReason,
  type WorkflowAvailability,
  type WorkflowCatalogEntry,
  WorkflowCatalogKey,
  type WorkflowTemplate,
} from "@cogwork/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type { ConnectionStoreService } from "./connection";
import type { CoordinationService } from "./coordination";
import type { Credential } from "./credential-store";
import { type GranolaHttpFailure, makeGranolaHttp } from "./granola-http";
import {
  SourceFailure,
  type TriggerEvent,
  type TriggerSource,
  type TriggerSubscription,
} from "./trigger-source";
import type { WorkflowCatalogContribution } from "./workflow-catalog";

const generatedKey = Schema.decodeSync(WorkflowCatalogKey)("granola.note-generated");
const editedKey = Schema.decodeSync(WorkflowCatalogKey)("granola.note-edited");

export interface GranolaNoteSnapshot {
  readonly connection: ConnectionId;
  readonly noteId: string;
  readonly updatedAt: string;
  readonly updatedAtMillis: number;
  readonly title: string;
  readonly attendees: ReadonlyArray<string>;
  readonly calendarEvent: string;
  readonly summary: string | null;
  readonly transcript: string | null;
}

export interface GranolaSourceAdapter {
  readonly read: (
    credential: Credential,
    connection: ConnectionId,
    updatedAfterMillis: number,
  ) => Effect.Effect<ReadonlyArray<GranolaNoteSnapshot>, SourceFailure>;
}

export interface GranolaSourceAdapters {
  readonly rest: GranolaSourceAdapter;
  readonly mcp: GranolaSourceAdapter;
}

const restEndpoint = "https://api.granola.ai/v1/notes";
const mcpEndpoint = "https://mcp.granola.ai/mcp";
const futureTimestampToleranceMillis = 5 * 60 * 1_000;
const pageLimit = 100;
const noteLimit = 1_000;
const contentLengthLimit = 8 * 1024 * 1024;
const BoundedContent = Schema.String.check(Schema.isMaxLength(contentLengthLimit));

const RestAttendee = Schema.Union([
  BoundedContent,
  Schema.Struct({ name: Schema.optional(BoundedContent), email: Schema.optional(BoundedContent) }),
]);

const RestTranscriptSegment = Schema.Struct({
  speaker: Schema.optional(BoundedContent),
  text: BoundedContent,
});

const RestNote = Schema.Struct({
  id: BoundedContent,
  updated_at: BoundedContent,
  title: BoundedContent,
  attendees: Schema.optional(Schema.Array(RestAttendee).check(Schema.isMaxLength(noteLimit))),
  calendar_event: Schema.optional(Schema.NullOr(BoundedContent)),
  summary: Schema.optional(Schema.NullOr(BoundedContent)),
  summary_text: Schema.optional(Schema.NullOr(BoundedContent)),
  summary_markdown: Schema.optional(Schema.NullOr(BoundedContent)),
  transcript: Schema.optional(
    Schema.NullOr(
      Schema.Union([
        BoundedContent,
        Schema.Array(RestTranscriptSegment).check(Schema.isMaxLength(noteLimit)),
      ]),
    ),
  ),
});

const RestNotes = Schema.Array(RestNote).check(Schema.isMaxLength(noteLimit));

const RestPage = Schema.Union([
  Schema.Struct({
    data: RestNotes,
    has_more: Schema.optional(Schema.Boolean),
    next_cursor: Schema.optional(Schema.NullOr(BoundedContent)),
  }),
  Schema.Struct({
    notes: RestNotes,
    has_more: Schema.optional(Schema.Boolean),
    next_cursor: Schema.optional(Schema.NullOr(BoundedContent)),
  }),
]);

const McpCallResponse = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.Union([BoundedContent, Schema.Finite]),
  result: Schema.Struct({
    content: Schema.Array(Schema.Struct({ type: Schema.Literal("text"), text: BoundedContent })).check(
      Schema.isMaxLength(noteLimit),
    ),
    isError: Schema.optional(Schema.Boolean),
  }),
});

const McpMeeting = Schema.Struct({
  noteId: BoundedContent,
  updatedAt: BoundedContent,
  updatedAtMillis: Schema.Finite,
  title: BoundedContent,
  attendees: Schema.Array(BoundedContent).check(Schema.isMaxLength(noteLimit)),
  calendarEvent: BoundedContent,
  summary: Schema.NullOr(BoundedContent),
  transcript: Schema.NullOr(BoundedContent),
});

const McpMeetingAttributes = Schema.Struct({
  id: BoundedContent,
  title: BoundedContent,
  meeting_at: BoundedContent,
  updated_at: BoundedContent,
});

const McpPaginationAttributes = Schema.Struct({
  has_more: Schema.Literals(["true", "false"]),
  next_cursor: Schema.optional(BoundedContent),
});

interface AdapterPage {
  readonly notes: ReadonlyArray<GranolaNoteSnapshot>;
  readonly nextCursor: string | null;
}

const adapterFailure = (
  reason: SourceFailure["reason"],
  message: string,
  retryAfterMillis: number | null = null,
) => new SourceFailure({ source: "granola", reason, retryAfterMillis, message });

const requiredPaginationCursor = Effect.fn("GranolaSource.requiredPaginationCursor")(function* (
  cursor: string | null | undefined,
) {
  const isMissing = cursor === null || cursor === undefined;
  if (isMissing) {
    return yield* adapterFailure("decode", "Granola pagination cursor is missing");
  }
  return cursor;
});

const paginationCursor = Effect.fn("GranolaSource.paginationCursor")(function* (
  hasMore: boolean,
  cursor: string | null | undefined,
) {
  if (!hasMore) return null;
  return yield* requiredPaginationCursor(cursor);
});

const attendeeText = (value: typeof RestAttendee.Type) => {
  if (typeof value === "string") return value;
  return [value.name, value.email].filter((member): member is string => member !== undefined).join(" · ");
};

const hasText = (value: string | null | undefined) => Boolean(value?.trim());

const transcriptText = (value: (typeof RestNote.Type)["transcript"]) => {
  if (value === null || value === undefined || typeof value === "string") return value ?? null;
  return value.map(({ speaker, text }) => (speaker ? `${speaker}: ${text}` : text)).join("\n");
};

const timestampOf = Effect.fn("GranolaSource.timestampOf")(function* (value: string, now: number) {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) {
    return yield* adapterFailure("decode", `Granola returned invalid updated_at "${value}"`);
  }
  if (millis > now + futureTimestampToleranceMillis) {
    return yield* adapterFailure("decode", `Granola returned future updated_at "${value}"`);
  }
  return millis;
});

const restPage = (connection: ConnectionId, input: unknown) =>
  Schema.decodeUnknownEffect(RestPage)(input).pipe(
    Effect.mapError((error) =>
      adapterFailure("decode", `Granola REST response did not decode: ${error.message}`),
    ),
    Effect.flatMap((page) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) => {
          const notes = "data" in page ? page.data : page.notes;
          return Effect.forEach(notes, (note) =>
            timestampOf(note.updated_at, now).pipe(
              Effect.map((updatedAtMillis) => ({
                connection,
                noteId: note.id,
                updatedAt: note.updated_at,
                updatedAtMillis,
                title: note.title,
                attendees: (note.attendees ?? []).map(attendeeText),
                calendarEvent: note.calendar_event ?? "",
                summary: [note.summary_markdown, note.summary_text, note.summary].find(hasText) ?? null,
                transcript: transcriptText(note.transcript),
              })),
            ),
          ).pipe(
            Effect.flatMap((notes) =>
              paginationCursor(page.has_more === true, page.next_cursor).pipe(
                Effect.map((nextCursor) => ({ notes, nextCursor }) satisfies AdapterPage),
              ),
            ),
          );
        }),
      ),
    ),
  );

const xmlText = (value: string) =>
  value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&")
    .trim();

const attributesOf = (text: string) =>
  Object.fromEntries(
    [...text.matchAll(/([A-Za-z_][\w:-]*)="([^"]*)"/g)].map((match) => [
      match[1] ?? "",
      xmlText(match[2] ?? ""),
    ]),
  );

const childText = (text: string, tags: ReadonlyArray<string>) =>
  tags
    .flatMap((tag) => [text.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"))])
    .flatMap((match) => (match?.[1] === undefined ? [] : [xmlText(match[1])]))[0] ?? null;

const attendeeTextFrom = (body: string) => {
  const container = body.match(/<known_participants(?:\s[^>]*)?>([\s\S]*?)<\/known_participants>/i)?.[1];
  if (!container) return [];
  const listed = [...container.matchAll(/<(?:participant|attendee)\s+([^>]*?)(?:\/?>)/gi)].flatMap(
    (match) => {
      const attributes = attributesOf(match[1] ?? "");
      const value = [attributes.name, attributes.email]
        .filter((member): member is string => member !== undefined)
        .join(" · ");
      return value === "" ? [] : [value];
    },
  );
  if (listed.length > 0) return listed;
  const text = xmlText(container.replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));
  return text === "" ? [] : [text];
};

const decodeMcpMeeting = Effect.fn("GranolaSource.decodeMcpMeeting")(function* (
  attributesText: string,
  body: string,
  now: number,
) {
  const attributes = yield* Schema.decodeUnknownEffect(McpMeetingAttributes)(
    attributesOf(attributesText),
  ).pipe(
    Effect.mapError((error) =>
      adapterFailure("decode", `Granola MCP meeting attributes did not decode: ${error.message}`),
    ),
  );
  const updatedAtMillis = yield* timestampOf(attributes.updated_at, now);
  return yield* Schema.decodeEffect(McpMeeting)({
    noteId: attributes.id,
    updatedAt: attributes.updated_at,
    updatedAtMillis,
    title: attributes.title,
    attendees: attendeeTextFrom(body),
    calendarEvent: childText(body, ["calendar_event"]) ?? attributes.meeting_at,
    summary: childText(body, ["summary", "summary_text", "summary_markdown"]),
    transcript: childText(body, ["transcript"]),
  }).pipe(
    Effect.mapError((error) =>
      adapterFailure("decode", `Granola MCP meeting did not decode: ${error.message}`),
    ),
  );
});

const mcpPage = Effect.fn("GranolaSource.decodeMcpPage")(function* (
  connection: ConnectionId,
  input: unknown,
) {
  const response = yield* Schema.decodeUnknownEffect(McpCallResponse)(input).pipe(
    Effect.mapError((error) =>
      adapterFailure("decode", `Granola MCP response did not decode: ${error.message}`),
    ),
  );
  if (response.result.isError === true)
    return yield* adapterFailure("unavailable", "Granola MCP rejected list_meetings");
  const text = response.result.content.map(({ text }) => text).join("\n");
  const meetings = [...text.matchAll(/<meeting\s+([^>]*?)>([\s\S]*?)<\/meeting>/gi)];
  if (meetings.length > noteLimit)
    return yield* adapterFailure("decode", "Granola returned too many meetings");
  const now = yield* Clock.currentTimeMillis;
  const notes = yield* Effect.forEach(meetings, (meeting) =>
    decodeMcpMeeting(meeting[1] ?? "", meeting[2] ?? "", now).pipe(
      Effect.map((note) => ({ ...note, connection }) satisfies GranolaNoteSnapshot),
    ),
  );
  const paginationText = text.match(/<pagination\s+([^>]*?)(?:\/?>)/i)?.[1] ?? "";
  const pagination = yield* Schema.decodeUnknownEffect(McpPaginationAttributes)(
    attributesOf(paginationText),
  ).pipe(
    Effect.mapError((error) =>
      adapterFailure("decode", `Granola MCP pagination did not decode: ${error.message}`),
    ),
  );
  const nextCursor = yield* paginationCursor(pagination.has_more === "true", pagination.next_cursor);
  return {
    notes,
    nextCursor,
  } satisfies AdapterPage;
});

const isoInstant = (millis: number) =>
  Option.match(DateTime.make(millis), { onNone: () => String(millis), onSome: DateTime.formatIso });

interface PaginationState {
  readonly cursor: string | null;
  readonly seen: ReadonlySet<string>;
  readonly pageCount: number;
  readonly noteCount: number;
}

const initialPage: PaginationState = { cursor: null, seen: new Set(), pageCount: 0, noteCount: 0 };

const advancePage = (state: PaginationState, page: AdapterPage) => {
  const noteCount = state.noteCount + page.notes.length;
  if (noteCount > noteLimit) return Effect.fail(adapterFailure("decode", "Granola returned too many notes"));
  if (page.nextCursor === null) {
    return Effect.succeed([page.notes, Option.none<PaginationState>()] satisfies readonly [
      ReadonlyArray<GranolaNoteSnapshot>,
      Option.Option<PaginationState>,
    ]);
  }
  const pageCount = state.pageCount + 1;
  if (pageCount >= pageLimit) return Effect.fail(adapterFailure("decode", "Granola returned too many pages"));
  if (state.seen.has(page.nextCursor)) {
    return Effect.fail(adapterFailure("decode", "Granola returned a repeated page cursor"));
  }
  return Effect.succeed([
    page.notes,
    Option.some({
      cursor: page.nextCursor,
      seen: new Set([...state.seen, page.nextCursor]),
      pageCount,
      noteCount,
    }),
  ] satisfies readonly [ReadonlyArray<GranolaNoteSnapshot>, Option.Option<PaginationState>]);
};

const readPages = (read: (cursor: string | null) => Effect.Effect<AdapterPage, SourceFailure>) =>
  Stream.paginate(initialPage, (state) =>
    read(state.cursor).pipe(Effect.flatMap((page) => advancePage(state, page))),
  ).pipe(
    Stream.runCollect,
    Effect.map((notes) => [...notes]),
  );

const sourceFailure = (error: GranolaHttpFailure) =>
  adapterFailure(error.reason, error.message, error.retryAfterMillis);

const restAdapter = (client: HttpClient.HttpClient) =>
  ({
    read: (credential, connection, updatedAfterMillis) =>
      readPages((cursor) => {
        const url = new URL(restEndpoint);
        url.searchParams.set("updated_after", isoInstant(updatedAfterMillis));
        if (cursor !== null) url.searchParams.set("cursor", cursor);
        return makeGranolaHttp(client)
          .execute(credential, HttpClientRequest.get(url.toString()))
          .pipe(
            Effect.mapError(sourceFailure),
            Effect.flatMap((body) => restPage(connection, body)),
          );
      }),
  }) satisfies GranolaSourceAdapter;

const mcpAdapter = (client: HttpClient.HttpClient) =>
  ({
    read: (credential, connection, updatedAfterMillis) =>
      readPages((cursor) =>
        HttpClientRequest.bodyJson(HttpClientRequest.post(mcpEndpoint), {
          jsonrpc: "2.0",
          id: cursor ?? "first",
          method: "tools/call",
          params: {
            name: "list_meetings",
            arguments: {
              updated_after: isoInstant(updatedAfterMillis),
              ...(cursor === null ? {} : { cursor }),
            },
          },
        }).pipe(
          Effect.mapError(() => adapterFailure("unavailable", "Could not build the Granola MCP request")),
          Effect.flatMap((request) => makeGranolaHttp(client).execute(credential, request)),
          Effect.mapError((error) => (error._tag === "GranolaHttpFailure" ? sourceFailure(error) : error)),
          Effect.flatMap((body) => mcpPage(connection, body)),
        ),
      ),
  }) satisfies GranolaSourceAdapter;

export const makeGranolaSourceAdapters = (client: HttpClient.HttpClient) =>
  ({
    rest: restAdapter(client),
    mcp: mcpAdapter(client),
  }) satisfies GranolaSourceAdapters;

const entry = (key: typeof generatedKey, name: string) =>
  ({
    key,
    name,
    kind: "trigger",
    system: "granola",
    connection: "granola",
    requires: [],
    parameters: [],
    itemKind: "granola-note",
    actsOn: [],
    requiresWorkspace: false,
    permissionProfile: "read-only",
    agentInputs: [],
    emits: [],
  }) satisfies WorkflowCatalogEntry;

export const granolaEntries = [
  entry(generatedKey, "Note generated"),
  entry(editedKey, "Note edited"),
] satisfies ReadonlyArray<WorkflowCatalogEntry>;

export const granolaWorkflowCatalogContribution: WorkflowCatalogContribution = {
  entries: granolaEntries,
  templates: [] satisfies ReadonlyArray<WorkflowTemplate>,
};

const connectionFailure = (message: string) =>
  new SourceFailure({
    source: "granola",
    reason: "connection-not-ready",
    retryAfterMillis: null,
    message,
  });

const contentRequirements: ReadonlyArray<{
  readonly missing: (note: GranolaNoteSnapshot) => boolean;
  readonly reason: string;
}> = [
  { missing: (note) => !note.summary, reason: "Granola note has no summary" },
  { missing: (note) => !note.transcript, reason: "Granola note has no transcript" },
];

const rejectedReason = (note: GranolaNoteSnapshot) =>
  contentRequirements.find(({ missing }) => missing(note))?.reason ?? null;

const payloadOf = (note: GranolaNoteSnapshot) => {
  const reason = rejectedReason(note);
  if (reason !== null) return { _tag: "GranolaNoteRejected", reason } satisfies TriggerEvent["payload"];
  return {
    _tag: "GranolaNote",
    title: note.title,
    attendees: note.attendees,
    calendarEvent: note.calendarEvent,
    summary: note.summary ?? "",
    transcript: note.transcript ?? "",
  } satisfies TriggerEvent["payload"];
};

const eventOf = Effect.fn("GranolaSource.eventOf")(function* (
  coordination: CoordinationService,
  subscriptions: ReadonlyArray<TriggerSubscription>,
  note: GranolaNoteSnapshot,
) {
  const key = { _tag: "GranolaNote", connection: note.connection, noteId: note.noteId } as const;
  const prior = yield* coordination
    .read(key)
    .pipe(
      Effect.mapError((error) =>
        adapterFailure("unavailable", `Could not read the prior Granola revision: ${error.message}`),
      ),
    );
  const rejectedGeneratedRevision =
    prior.park !== null &&
    ParkReason.guards.PlanRejected(prior.park.reason) &&
    prior.park.reason.entry === generatedKey;
  const isGeneratedRevision = prior.revision === null || rejectedGeneratedRevision;
  const event = {
    key,
    revision: note.updatedAt,
    cause: { _tag: "Unknown" },
    atMillis: note.updatedAtMillis,
    entry: isGeneratedRevision ? generatedKey : editedKey,
    workspace: null,
    payload: payloadOf(note),
  } satisfies TriggerEvent;
  const matchedSubscription = subscriptions.some((subscription) => {
    const afterCatchUp = subscription.catchUp === null || event.atMillis >= subscription.catchUp.since;
    return subscription.entry === event.entry && afterCatchUp;
  });
  if (event.payload?._tag !== "GranolaNoteRejected") return event;
  if (!matchedSubscription) return event;
  yield* coordination
    .park(key, { _tag: "PlanRejected", reason: event.payload.reason, entry: event.entry })
    .pipe(
      Effect.mapError((error) =>
        adapterFailure("unavailable", `Could not record the Granola plan rejection: ${error.message}`),
      ),
    );
  return event;
});

const updatedAfter = (subscriptions: ReadonlyArray<TriggerSubscription>, now: number) =>
  Math.min(...subscriptions.map(({ catchUp }) => catchUp?.since ?? now));

function pollGranola(
  connections: ConnectionStoreService,
  adapters: GranolaSourceAdapters,
  coordination: CoordinationService,
  subscriptions: ReadonlyArray<TriggerSubscription>,
  updatedAfterMillis: number,
) {
  return Effect.gen(function* () {
    const connection = yield* connections
      .findSystem("granola")
      .pipe(Effect.mapError((error) => connectionFailure(error.message)));
    if (connection === null) return yield* connectionFailure("Granola Connection is not established");
    const readiness = yield* connections.readiness(connection.id);
    if (readiness._tag === "NotReady") return yield* connectionFailure(readiness.reason);
    const credential = yield* connections
      .bearer(connection.id)
      .pipe(Effect.mapError((error) => connectionFailure(error.message)));
    const adapter = credential.source === "stored-oauth" ? adapters.mcp : adapters.rest;
    const notes = yield* adapter.read(credential, connection.id, updatedAfterMillis);
    return yield* Effect.forEach(notes, (note) => eventOf(coordination, subscriptions, note));
  });
}

export const makeGranolaSource = (
  connections: ConnectionStoreService,
  adapters: GranolaSourceAdapters,
  coordination: CoordinationService,
) =>
  ({
    id: "granola",
    entries: granolaEntries,
    availability: (_entry) =>
      Effect.gen(function* () {
        const connection = yield* connections.findSystem("granola");
        if (connection === null) return { _tag: "ConnectionNeeded" } satisfies WorkflowAvailability;
        const readiness = yield* connections.readiness(connection.id);
        return readiness._tag === "Ready"
          ? ({ _tag: "Available" } satisfies WorkflowAvailability)
          : ({ _tag: "Unavailable", reason: readiness.reason } satisfies WorkflowAvailability);
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed({ _tag: "Unavailable", reason: error.message } satisfies WorkflowAvailability),
        ),
      ),
    listOptions: (_entry, _parameter) => Effect.succeed([]),
    observe: (subscriptions) => {
      if (subscriptions.length === 0) return Stream.empty;
      const next = (state: { readonly watermark: number; readonly first: boolean }) =>
        (state.first ? Effect.void : Effect.sleep("60 seconds")).pipe(
          Effect.andThen(pollGranola(connections, adapters, coordination, subscriptions, state.watermark)),
          Effect.map((events) => {
            const watermark = events.reduce(
              (latest, event) => Math.max(latest, event.atMillis),
              state.watermark,
            );
            return [events, { watermark, first: false }] satisfies readonly [
              ReadonlyArray<TriggerEvent>,
              { readonly watermark: number; readonly first: boolean },
            ];
          }),
        );
      return Stream.unwrap(
        Clock.currentTimeMillis.pipe(
          Effect.map((now) =>
            Stream.unfold({ watermark: updatedAfter(subscriptions, now), first: true }, next).pipe(
              Stream.flatMap(Stream.fromIterable),
            ),
          ),
        ),
      );
    },
  }) satisfies TriggerSource;
