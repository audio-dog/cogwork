import type {
  AgUiEvent,
  HarnessName,
  Session,
  SessionId,
  SessionKind,
  WorkspaceId,
} from "@cogwork/contracts";
import {
  agUiDisplayName,
  agUiIsTerminal,
  agUiTextDelta,
  SessionId as SessionIdSchema,
} from "@cogwork/contracts";
import { InMemoryRunStore, type ModelMessage } from "@tanstack/ai";
import {
  type ChatWithInterruptsPersistence,
  defineAIPersistence,
  type MessageStore,
} from "@tanstack/ai-persistence";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { makeInterruptStore } from "./interrupt-store";
import { handleOf, RunLedger } from "./run-ledger";
import { RunRecorder, type RunRecorderService } from "./run-recorder";

export interface ThreadMessage {
  readonly role: "assistant" | "tool";
  readonly content: string;
  readonly toolName?: string;
}

export interface MintSpec {
  readonly workspace: WorkspaceId;
  readonly harness: HarnessName;
  readonly createdAtMillis: number;
}

export interface SessionStoreService {
  // The `@tanstack/ai-persistence` adapter the provider runner runs under: a
  // ledger-backed message store (load folds the ledger, save is a no-op so the
  // event-sourced ledger stays the one truth) beside process-scoped run and
  // interrupt stores for durable pause/resume.
  readonly persistence: ChatWithInterruptsPersistence;
  // The opaque handle a CLI runner resumes its own history from.
  readonly resumeHandle: (session: SessionId) => Effect.Effect<string | null>;
  // Mints a session, taking its kind from `kindFor` (the harness service's
  // declaration) so the caller names a harness, never a kind.
  readonly mint: (spec: MintSpec, kindFor: (harness: HarnessName) => SessionKind) => Effect.Effect<SessionId>;
}

export class SessionStore extends Context.Service<SessionStore, SessionStoreService>()(
  "@cogwork/engine/session-store/SessionStore",
) {}

interface FoldState {
  readonly messages: ReadonlyArray<ThreadMessage>;
  readonly text: string;
  readonly seenTools: ReadonlySet<string>;
}

const emptyFold: FoldState = { messages: [], text: "", seenTools: new Set() };

const flushText = (state: FoldState): FoldState =>
  state.text.length === 0
    ? state
    : { ...state, messages: [...state.messages, { role: "assistant", content: state.text }], text: "" };

const toolCallId = (event: AgUiEvent) =>
  event.type.startsWith("TOOL_CALL_") ? (event.toolCallId ?? null) : null;

const StructuredOutputCompleteValue = Schema.Struct({ raw: Schema.String });
const decodeStructuredOutputCompleteValue = Schema.decodeUnknownOption(StructuredOutputCompleteValue);

const structuredOutputRaw = (event: AgUiEvent) => {
  if (event.type !== "CUSTOM" || event.name !== "structured-output.complete") return null;
  return Option.getOrNull(Option.map(decodeStructuredOutputCompleteValue(event.value), (value) => value.raw));
};

const appendStructuredOutput = (state: FoldState, raw: string): FoldState => {
  const flushed = flushText(state);
  const previous = flushed.messages.at(-1);
  if (previous?.role === "assistant" && previous.content === raw) return flushed;
  return {
    ...flushed,
    messages: [...flushed.messages, { role: "assistant", content: raw }],
  };
};

const appendTool = (state: FoldState, event: AgUiEvent, callId: string): FoldState => {
  const flushed = flushText(state);
  return {
    messages: [
      ...flushed.messages,
      { role: "tool", content: event.args ?? "", toolName: agUiDisplayName(event) ?? "tool" },
    ],
    text: "",
    seenTools: new Set(flushed.seenTools).add(callId),
  };
};

const foldEvent = (state: FoldState, event: AgUiEvent): FoldState => {
  const delta = agUiTextDelta(event);
  if (delta.length > 0) return { ...state, text: state.text + delta };
  const structured = structuredOutputRaw(event);
  if (structured !== null) return appendStructuredOutput(state, structured);
  const callId = toolCallId(event);
  if (callId && !state.seenTools.has(callId)) return appendTool(state, event, callId);
  return agUiIsTerminal(event) ? flushText(state) : state;
};

// Takes the harness events the recorder already decoded and folds them into transcript messages.
// The recorder owns the decode, so this never touches a run event's stored payload.
export const foldThread = (events: ReadonlyArray<AgUiEvent>) =>
  flushText(events.reduce(foldEvent, emptyFold)).messages;

const labelToolResult = (message: ThreadMessage) =>
  message.toolName ? `Result from ${message.toolName}:\n${message.content}` : message.content;

// A resumed transcript is a coarse fold: no tool-call ids survive, so prior tool
// results ride back as labelled user turns rather than malformed tool turns.
export const toModelMessages = (thread: ReadonlyArray<ThreadMessage>): Array<ModelMessage> =>
  thread.map((message) =>
    message.role === "assistant"
      ? { role: "assistant", content: message.content }
      : { role: "user", content: labelToolResult(message) },
  );

const decodeSession = Schema.decodeUnknownOption(SessionIdSchema);
const decodeSessionId = Schema.decodeUnknownEffect(SessionIdSchema);

const newSession = (spec: MintSpec, id: SessionId, kind: SessionKind): Session =>
  kind === "owned-transcript" ? { kind, id, ...spec } : { kind, id, ...spec, handle: null };

// `loadThread` folds the session's decoded harness events (from the recorder) into model messages;
// `saveThread` is a no-op because the executor already appends every event to the ledger, so writing
// the transcript back would fork the one truth.
const ledgerMessageStore = (recorder: RunRecorderService): MessageStore => ({
  loadThread: (threadId) =>
    Effect.runPromise(
      Option.match(decodeSession(threadId), {
        onNone: (): Effect.Effect<ReadonlyArray<AgUiEvent>> => Effect.succeed([]),
        onSome: (session): Effect.Effect<ReadonlyArray<AgUiEvent>> => recorder.sessionEvents(session),
      }).pipe(Effect.map((events) => toModelMessages(foldThread(events)))),
    ),
  saveThread: () => Promise.resolve(),
});

export const make = Effect.gen(function* () {
  const ledger = yield* RunLedger;
  const recorder = yield* RunRecorder;
  const counter = yield* Ref.make(0);
  const persistence: ChatWithInterruptsPersistence = defineAIPersistence({
    stores: {
      messages: ledgerMessageStore(recorder),
      runs: new InMemoryRunStore(),
      interrupts: makeInterruptStore(),
    },
  });
  const nextId = (createdAtMillis: number) =>
    Ref.getAndUpdate(counter, (n) => n + 1).pipe(
      Effect.flatMap((n) => decodeSessionId(`sess-${createdAtMillis}-${n}`)),
      Effect.orDie,
    );
  return {
    persistence,
    resumeHandle: Effect.fn("SessionStore.resumeHandle")(function* (session: SessionId) {
      return yield* handleOf(ledger, session);
    }),
    mint: Effect.fn("SessionStore.mint")(function* (
      spec: MintSpec,
      kindFor: (harness: HarnessName) => SessionKind,
    ) {
      const id = yield* nextId(spec.createdAtMillis);
      yield* ledger.insertSession(newSession(spec, id, kindFor(spec.harness)));
      return id;
    }),
  } satisfies SessionStoreService;
});

export const layer = Layer.effect(SessionStore, make);
