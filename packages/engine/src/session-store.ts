import type { AgUiEvent, RunEvent, SessionId } from "@clanker-forge/contracts";
import {
  AgUiEvent as AgUiEventSchema,
  agUiDisplayName,
  agUiIsTerminal,
  agUiTextDelta,
  SessionId as SessionIdSchema,
} from "@clanker-forge/contracts";
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
import * as Schema from "effect/Schema";
import { makeInterruptStore } from "./interrupt-store";
import { handleOf, RunLedger, type RunLedgerService } from "./run-ledger";

export interface ThreadMessage {
  readonly role: "assistant" | "tool";
  readonly content: string;
  readonly toolName?: string;
}

export interface SessionStoreService {
  // The `@tanstack/ai-persistence` adapter the provider runner runs under: a
  // ledger-backed message store (load folds the ledger, save is a no-op so the
  // event-sourced ledger stays the one truth) beside process-scoped run and
  // interrupt stores for durable pause/resume.
  readonly persistence: ChatWithInterruptsPersistence;
  // The opaque handle a CLI runner resumes its own history from.
  readonly resumeHandle: (session: SessionId) => Effect.Effect<string | null>;
}

export class SessionStore extends Context.Service<SessionStore, SessionStoreService>()(
  "@clanker-forge/engine/session-store/SessionStore",
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
  const callId = toolCallId(event);
  if (callId && !state.seenTools.has(callId)) return appendTool(state, event, callId);
  return agUiIsTerminal(event) ? flushText(state) : state;
};

const decodeEvent = Schema.decodeUnknownOption(Schema.fromJsonString(AgUiEventSchema));

export const foldThread = (events: ReadonlyArray<{ readonly data: string }>) => {
  const decoded = events.flatMap((event) =>
    Option.match(decodeEvent(event.data), { onNone: () => [], onSome: (value) => [value] }),
  );
  return flushText(decoded.reduce(foldEvent, emptyFold)).messages;
};

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

// `loadThread` folds the session's run events into model messages; `saveThread`
// is a no-op because the executor already appends every event to the ledger, so
// writing the transcript back would fork the one truth.
const ledgerMessageStore = (ledger: RunLedgerService): MessageStore => ({
  loadThread: (threadId) =>
    Effect.runPromise(
      Option.match(decodeSession(threadId), {
        onNone: () => Effect.succeed<ReadonlyArray<RunEvent>>([]),
        onSome: (session) => ledger.sessionEvents(session),
      }).pipe(Effect.map((events) => toModelMessages(foldThread(events)))),
    ),
  saveThread: () => Promise.resolve(),
});

export const make = Effect.gen(function* () {
  const ledger = yield* RunLedger;
  const persistence: ChatWithInterruptsPersistence = defineAIPersistence({
    stores: {
      messages: ledgerMessageStore(ledger),
      runs: new InMemoryRunStore(),
      interrupts: makeInterruptStore(),
    },
  });
  return {
    persistence,
    resumeHandle: Effect.fn("SessionStore.resumeHandle")(function* (session: SessionId) {
      return yield* handleOf(ledger, session);
    }),
  } satisfies SessionStoreService;
});

export const layer = Layer.effect(SessionStore, make);
