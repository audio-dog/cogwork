import type { AgUiEvent, SessionId } from "@clanker-forge/contracts";
import {
  AgUiEvent as AgUiEventSchema,
  agUiDisplayName,
  agUiIsTerminal,
  agUiTextDelta,
} from "@clanker-forge/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { RunLedger } from "./run-ledger";

export interface ThreadMessage {
  readonly role: "assistant" | "tool";
  readonly content: string;
  readonly toolName?: string;
}

export interface SessionStoreService {
  readonly loadThread: (session: SessionId) => Effect.Effect<ReadonlyArray<ThreadMessage>>;
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

export const make = Effect.gen(function* () {
  const ledger = yield* RunLedger;
  return {
    loadThread: Effect.fn("SessionStore.loadThread")(function* (session: SessionId) {
      return foldThread(yield* ledger.sessionEvents(session));
    }),
  } satisfies SessionStoreService;
});

export const layer = Layer.effect(SessionStore, make);
