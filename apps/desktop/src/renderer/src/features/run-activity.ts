import {
  AgUiEvent,
  agUiIsFileDiffEvent,
  agUiIsFileDiffUnavailableEvent,
  agUiIsSessionHandleEvent,
  agUiIsSubagentEvent,
  agUiTextDelta,
  type RunActivity,
  type RunId,
  RunWatchItem,
} from "@cogwork/contracts";
import { useAtomRefresh, useAtomSet, useAtomSubscribe, useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import * as Chunk from "effect/Chunk";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { RpcClientError } from "effect/rpc/RpcClientError";
import { useCallback } from "react";

import { runActivityAtom } from "../daemon/atoms";

export interface RunActivityPreview {
  readonly label: string;
  readonly text: string;
}

const maxTextLength = 160;

const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();

const clip = (value: string) =>
  value.length > maxTextLength ? `${value.slice(0, maxTextLength - 1)}…` : value;

const firstString = (...values: ReadonlyArray<unknown>) =>
  values.find((value): value is string => typeof value === "string") ?? "";

const customDetailText = (value: unknown) => {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return JSON.stringify(value) ?? "";
};

interface TextBuffer {
  readonly messageId: string | null;
  readonly text: string;
}

interface PreviewEntry {
  readonly preview: RunActivityPreview;
  readonly text: TextBuffer | null;
  readonly tools: ReadonlyMap<string, string>;
}

export type RunPreviewState = ReadonlyMap<string, PreviewEntry>;

type NamedEvent<Type extends string> = Extract<AgUiEvent, { readonly type: Type }>;

const toolKey = (runId: string, event: { readonly toolCallId?: string }) =>
  `${runId}:${event.toolCallId ?? ""}`;

const entryFor = (state: RunPreviewState, runId: string): PreviewEntry =>
  state.get(runId) ?? { preview: { label: "starting", text: "" }, text: null, tools: new Map() };

const withPreview = (entry: PreviewEntry, label: string, text: string) => ({
  ...entry,
  preview: { label, text: clip(oneLine(text)) },
});

const setEntry = (state: RunPreviewState, runId: string, update: (entry: PreviewEntry) => PreviewEntry) =>
  new Map(state).set(runId, update(entryFor(state, runId)));

const onRunStarted = (state: RunPreviewState, { runId }: RunActivity) =>
  setEntry(state, runId, (entry) => withPreview(entry, "starting", ""));

const onText = (
  state: RunPreviewState,
  { runId, correlation }: RunActivity,
  event: NamedEvent<"TEXT_MESSAGE_CONTENT">,
) =>
  setEntry(state, runId, (entry) => {
    const messageId = event.messageId ?? correlation.messageId ?? null;
    const previous = entry.text;
    const base = previous?.messageId === messageId ? previous.text : "";
    const text = base.length >= maxTextLength ? base : base + agUiTextDelta(event);
    return { ...withPreview(entry, "responding", text), text: { messageId, text } };
  });

const onToolStart = (state: RunPreviewState, runId: string, event: NamedEvent<"TOOL_CALL_START">) =>
  setEntry(state, runId, (entry) => {
    const name = event.toolCallName ?? "tool";
    return {
      ...withPreview(entry, name, ""),
      tools: new Map(entry.tools).set(toolKey(runId, event), name),
    };
  });

const onToolEnd = (
  state: RunPreviewState,
  runId: string,
  event: NamedEvent<"TOOL_CALL_END"> | NamedEvent<"TOOL_CALL_RESULT">,
  result: string,
) =>
  setEntry(state, runId, (entry) =>
    withPreview(entry, entry.tools.get(toolKey(runId, event)) ?? event.toolCallName ?? "tool", result),
  );

const onStep = (state: RunPreviewState, runId: string, event: NamedEvent<"STEP_STARTED">) => {
  if (!event.stepName) return state;
  const stepName = event.stepName;
  return setEntry(state, runId, (entry) => withPreview(entry, "step", stepName));
};

const onCustom = (state: RunPreviewState, runId: string, event: NamedEvent<"CUSTOM">) => {
  if (agUiIsSessionHandleEvent(event)) return state;
  return setEntry(state, runId, (entry) =>
    withPreview(entry, event.name ?? "custom", customDetailText(event.value)),
  );
};

const onRunFinished = (state: RunPreviewState, runId: string, event: NamedEvent<"RUN_FINISHED">) =>
  setEntry(state, runId, (entry) => withPreview(entry, "finished", event.finishReason ?? ""));

const onRunError = (state: RunPreviewState, runId: string, event: NamedEvent<"RUN_ERROR">) =>
  setEntry(state, runId, (entry) => withPreview(entry, "error", event.message ?? "run error"));

export const applyRunPreview = (state: RunPreviewState, activity: RunActivity) => {
  if (agUiIsSubagentEvent(activity.event)) return state;
  return AgUiEvent.matchOrElse(
    activity.event,
    {
      RUN_STARTED: () => onRunStarted(state, activity),
      TEXT_MESSAGE_CONTENT: (event) => onText(state, activity, event),
      TOOL_CALL_START: (event) => onToolStart(state, activity.runId, event),
      TOOL_CALL_END: (event) =>
        onToolEnd(state, activity.runId, event, firstString(event.result, event.content)),
      TOOL_CALL_RESULT: (event) =>
        onToolEnd(state, activity.runId, event, firstString(event.result, event.content)),
      STEP_STARTED: (event) => onStep(state, activity.runId, event),
      CUSTOM: (event) => onCustom(state, activity.runId, event),
      RUN_FINISHED: (event) => onRunFinished(state, activity.runId, event),
      RUN_ERROR: (event) => onRunError(state, activity.runId, event),
    },
    () => state,
  );
};

export const previewMap = (state: RunPreviewState): ReadonlyMap<string, RunActivityPreview> =>
  new Map([...state].map(([runId, entry]) => [runId, entry.preview]));

export const withoutRunPreview = (state: RunPreviewState, runId: string) => {
  if (!state.has(runId)) return state;
  const next = new Map(state);
  next.delete(runId);
  return next;
};

export type TranscriptEntry =
  | { readonly kind: "text"; readonly key: string; readonly text: string }
  | { readonly kind: "reasoning"; readonly key: string; readonly text: string }
  | {
      readonly kind: "tool";
      readonly key: string;
      readonly name: string;
      readonly args: string;
      readonly result: string | null;
      readonly complete: boolean;
    }
  | { readonly kind: "diff"; readonly key: string; readonly path: string; readonly diff: string }
  | { readonly kind: "warning"; readonly key: string; readonly message: string }
  | { readonly kind: "error"; readonly key: string; readonly message: string }
  | SubagentCard;

export type SubagentStatus = "running" | "finished" | "error";

export interface SubagentCard {
  readonly kind: "subagent";
  readonly key: string;
  readonly name: string;
  readonly status: SubagentStatus;
  readonly text: string;
  readonly message: string | null;
}

interface TranscriptFold {
  readonly entries: Iterable<TranscriptEntry>;
  readonly order: Chunk.Chunk<string>;
  readonly byKey: HashMap.HashMap<string, TranscriptEntry>;
  readonly lastSeq: number | null;
}

const entriesFor = (order: Chunk.Chunk<string>, byKey: HashMap.HashMap<string, TranscriptEntry>) => ({
  *[Symbol.iterator]() {
    for (const key of order) {
      const entry = HashMap.get(byKey, key);
      if (Option.isSome(entry)) yield entry.value;
    }
  },
});

const transcriptFold = (
  order: Chunk.Chunk<string>,
  byKey: HashMap.HashMap<string, TranscriptEntry>,
  lastSeq: number | null,
) => ({
  entries: entriesFor(order, byKey),
  order,
  byKey,
  lastSeq,
});

export const makeTranscriptFold = (): TranscriptFold =>
  transcriptFold(Chunk.empty<string>(), HashMap.empty<string, TranscriptEntry>(), null);

const transcriptToolKey = (toolCallId: string | null | undefined) => `tool:${toolCallId ?? ""}`;

const transcriptDiffKey = (path: string) => `diff:${path}`;

const setTranscriptEntry = (state: TranscriptFold, key: string, entry: TranscriptEntry) => {
  const order = HashMap.has(state.byKey, key) ? state.order : Chunk.append(state.order, key);
  return transcriptFold(order, HashMap.set(state.byKey, key, entry), state.lastSeq);
};

const append = (state: TranscriptFold, kind: "text" | "reasoning", key: string, delta: string) => {
  const existing = Option.getOrUndefined(HashMap.get(state.byKey, key));
  if (existing && (existing.kind === "text" || existing.kind === "reasoning")) {
    return setTranscriptEntry(state, key, { ...existing, text: existing.text + delta });
  }
  const entry: TranscriptEntry = { kind, key, text: delta };
  return setTranscriptEntry(state, key, entry);
};

const toolEntryFor = (state: TranscriptFold, toolCallId: string | null | undefined) => {
  const entry = Option.getOrUndefined(HashMap.get(state.byKey, transcriptToolKey(toolCallId)));
  return entry?.kind === "tool" ? entry : null;
};

const setDiffEntry = (state: TranscriptFold, path: string, diff: string) => {
  const key = transcriptDiffKey(path);
  const existing = Option.getOrUndefined(HashMap.get(state.byKey, key));
  if (existing?.kind === "diff") {
    return setTranscriptEntry(state, key, { ...existing, diff });
  }
  const entry: TranscriptEntry = { kind: "diff", key, path, diff };
  return setTranscriptEntry(state, key, entry);
};

const subagentKey = (subagentRunId: string | undefined) => `subagent:${subagentRunId ?? ""}`;

const placeSubagent = (state: TranscriptFold, card: SubagentCard, parentToolCallId: string | undefined) => {
  const toolKey = transcriptToolKey(parentToolCallId);
  if (parentToolCallId === undefined || !HashMap.has(state.byKey, toolKey)) {
    return setTranscriptEntry(state, card.key, card);
  }
  return transcriptFold(
    Chunk.map(state.order, (key) => (key === toolKey ? card.key : key)),
    HashMap.set(HashMap.remove(state.byKey, toolKey), card.key, card),
    state.lastSeq,
  );
};

const startSubagent = (state: TranscriptFold, event: NamedEvent<"SUBAGENT_STARTED">) => {
  const key = subagentKey(event.subagentRunId);
  if (HashMap.has(state.byKey, key)) return state;
  const card: SubagentCard = {
    kind: "subagent",
    key,
    name: event.name ?? "Subagent",
    status: "running",
    text: "",
    message: null,
  };
  return placeSubagent(state, card, event.parentToolCallId);
};

const updateSubagent = (
  state: TranscriptFold,
  subagentRunId: string | undefined,
  update: (card: SubagentCard) => SubagentCard,
) => {
  const entry = Option.getOrUndefined(HashMap.get(state.byKey, subagentKey(subagentRunId)));
  if (entry?.kind !== "subagent") return state;
  return setTranscriptEntry(state, entry.key, update(entry));
};

const foldSubagentActivity = (state: TranscriptFold, event: AgUiEvent) =>
  AgUiEvent.matchOrElse(
    event,
    {
      SUBAGENT_STARTED: (started) => startSubagent(state, started),
      TEXT_MESSAGE_START: ({ subagentRunId }) =>
        updateSubagent(state, subagentRunId, (card) =>
          card.text === "" ? card : { ...card, text: `${card.text}\n\n` },
        ),
      TEXT_MESSAGE_CONTENT: ({ subagentRunId, delta }) =>
        updateSubagent(state, subagentRunId, (card) => ({ ...card, text: card.text + (delta ?? "") })),
      SUBAGENT_FINISHED: ({ subagentRunId }) =>
        updateSubagent(state, subagentRunId, (card) => ({ ...card, status: "finished" })),
      SUBAGENT_ERROR: ({ subagentRunId, message }) =>
        updateSubagent(state, subagentRunId, (card) => ({
          ...card,
          status: "error",
          message: message ?? "Subagent error",
        })),
    },
    () => state,
  );

const foldTranscriptActivity = (state: TranscriptFold, activity: RunActivity) => {
  if (agUiIsSubagentEvent(activity.event)) return foldSubagentActivity(state, activity.event);
  return AgUiEvent.matchOrElse(
    activity.event,
    {
      TEXT_MESSAGE_CONTENT: ({ messageId, delta }) =>
        append(state, "text", `text:${messageId ?? "0"}`, delta ?? ""),
      REASONING_MESSAGE_CONTENT: ({ messageId, delta }) =>
        append(state, "reasoning", `reason:${messageId ?? "0"}`, delta ?? ""),
      TOOL_CALL_START: ({ toolCallId, toolCallName }) => {
        const key = transcriptToolKey(toolCallId);
        if (HashMap.has(state.byKey, key)) return state;
        const entry: TranscriptEntry = {
          kind: "tool",
          key,
          name: toolCallName ?? "tool",
          args: "",
          result: null,
          complete: false,
        };
        return setTranscriptEntry(state, key, entry);
      },
      TOOL_CALL_ARGS: ({ toolCallId, delta }) => {
        const entry = toolEntryFor(state, toolCallId);
        if (!entry) return state;
        return setTranscriptEntry(state, entry.key, { ...entry, args: entry.args + (delta ?? "") });
      },
      TOOL_CALL_END: ({ toolCallId, args }) => {
        const entry = toolEntryFor(state, toolCallId);
        if (!entry) return state;
        return setTranscriptEntry(state, entry.key, {
          ...entry,
          args: entry.args === "" && args ? args : entry.args,
          complete: true,
        });
      },
      TOOL_CALL_RESULT: ({ toolCallId, result, content }) => {
        const entry = toolEntryFor(state, toolCallId);
        if (!entry) return state;
        return setTranscriptEntry(state, entry.key, {
          ...entry,
          result: firstString(result, content),
          complete: true,
        });
      },
      CUSTOM: (event) => {
        if (agUiIsFileDiffEvent(event)) return setDiffEntry(state, event.value.path, event.value.diff);
        if (!agUiIsFileDiffUnavailableEvent(event)) return state;
        const entry: TranscriptEntry = {
          kind: "warning",
          key: `warning:${activity.seq}`,
          message: event.value.message,
        };
        return setTranscriptEntry(state, entry.key, entry);
      },
      RUN_ERROR: ({ message }) => {
        const entry: TranscriptEntry = {
          kind: "error",
          key: `error:${activity.seq}`,
          message: message ?? "run error",
        };
        return setTranscriptEntry(state, entry.key, entry);
      },
    },
    () => state,
  );
};

export const applyTranscriptActivities = (state: TranscriptFold, activities: ReadonlyArray<RunActivity>) =>
  activities.reduce((current, activity) => {
    if (current.lastSeq !== null && activity.seq <= current.lastSeq) return current;
    const next = foldTranscriptActivity(current, activity);
    return transcriptFold(next.order, next.byKey, activity.seq);
  }, state);

export const foldTranscript = (activities: ReadonlyArray<RunActivity>) => {
  const state = applyTranscriptActivities(makeTranscriptFold(), activities);
  return Array.from(state.entries);
};

type ActivityResult = typeof runActivityAtom extends (id: RunId) => Atom.Atom<infer V> ? V : never;
type ActivityError = ActivityResult extends AsyncResult.AsyncResult<unknown, infer E> ? E : never;

interface TranscriptSnapshot {
  readonly done: boolean;
  readonly replaying: boolean;
  readonly entries: Iterable<TranscriptEntry>;
}

type TranscriptResult = AsyncResult.AsyncResult<TranscriptSnapshot, ActivityError>;

export const transcriptReplaying = (result: TranscriptResult) =>
  !AsyncResult.isSuccess(result) || result.value.replaying;

export const makeTranscriptPump = () => {
  const cell: { source: TranscriptResult | null } = { source: null };
  return (current: TranscriptResult, pull: () => void, refresh: () => void) => {
    if (current.waiting || current === cell.source) return;
    cell.source = current;
    if (current._tag === "Failure" && streamReconnectable(current.cause)) return refresh();
    if (current._tag === "Success" && !current.value.done) pull();
  };
};

interface TranscriptCell {
  fold: TranscriptFold;
  replaying: boolean;
  source: ActivityResult | null;
  result: TranscriptResult;
}

const resetTranscriptCell = (cell: TranscriptCell, result: TranscriptResult) => {
  cell.fold = makeTranscriptFold();
  cell.replaying = true;
  cell.result = result;
  return result;
};

const streamCompleted = (cause: Cause.Cause<ActivityError>) =>
  Option.exists(Cause.findErrorOption(cause), Cause.isNoSuchElementError);

const streamReconnectable = (cause: Cause.Cause<ActivityError>) =>
  Option.exists(Cause.findErrorOption(cause), (error) => {
    if (!(error instanceof RpcClientError)) return false;
    return error.reason._tag === "SocketOpenError" || error.reason._tag === "SocketCloseError";
  });

const completeTranscriptCell = (cell: TranscriptCell) => {
  cell.replaying = false;
  cell.result = AsyncResult.success({ done: true, replaying: false, entries: cell.fold.entries });
  return cell.result;
};

const watchedActivities = (items: ReadonlyArray<RunWatchItem>) =>
  items.filter(RunWatchItem.guards.RunActivity).map((item) => item.activity);

const applyActivityResult = (cell: TranscriptCell, current: ActivityResult) => {
  if (current === cell.source) return cell.result;
  cell.source = current;
  if (current._tag === "Initial") {
    return resetTranscriptCell(cell, AsyncResult.initial<TranscriptSnapshot, ActivityError>(current.waiting));
  }
  if (current._tag === "Failure") {
    if (streamCompleted(current.cause)) return completeTranscriptCell(cell);
    return resetTranscriptCell(
      cell,
      AsyncResult.failure<TranscriptSnapshot, ActivityError>(current.cause, {
        waiting: current.waiting,
      }),
    );
  }
  const { done, items } = current.value;
  const historyEnded = done || items.some(RunWatchItem.guards.HistoryEnd);
  cell.fold = applyTranscriptActivities(cell.fold, watchedActivities(items));
  cell.replaying = cell.replaying && !historyEnded;
  cell.result = AsyncResult.success({ done, replaying: cell.replaying, entries: cell.fold.entries }, current);
  return cell.result;
};

export const makeTranscriptSource = () => {
  const cell: TranscriptCell = {
    fold: makeTranscriptFold(),
    replaying: true,
    source: null,
    result: AsyncResult.initial(),
  };
  return (current: ActivityResult) => applyActivityResult(cell, current);
};

const runTranscript = Atom.family((runId: RunId) => ({
  atom: Atom.map(runActivityAtom(runId), makeTranscriptSource()),
  pump: makeTranscriptPump(),
}));

export function useRunTranscript(runId: RunId) {
  const transcript = runTranscript(runId);
  const atom = transcript.atom;
  const result = useAtomValue(atom);
  const pull = useAtomSet(atom);
  const refresh = useAtomRefresh(atom);

  const pump = useCallback(
    (current: TranscriptResult) => transcript.pump(current, pull, refresh),
    [pull, refresh, transcript],
  );

  useAtomSubscribe(atom, pump, { immediate: true });

  return result;
}
