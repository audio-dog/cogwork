import {
  AgUiEvent,
  agUiIsSessionHandleEvent,
  agUiTextDelta,
  type RunActivity,
  type RunId,
} from "@cogwork/contracts";
import { useAtomSet, useAtomSubscribe, useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Atom from "effect/unstable/reactivity/Atom";
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

export const applyRunPreview = (state: RunPreviewState, activity: RunActivity) =>
  AgUiEvent.matchOrElse(
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

export const previewMap = (state: RunPreviewState): ReadonlyMap<string, RunActivityPreview> =>
  new Map([...state].map(([runId, entry]) => [runId, entry.preview]));

export const withoutRunPreview = (state: RunPreviewState, runId: string) => {
  if (!state.has(runId)) return state;
  const next = new Map(state);
  next.delete(runId);
  return next;
};

const FILE_DIFF_EVENT = "sandbox.file.diff";

const FileDiffValue = Schema.Struct({ path: Schema.String, diff: Schema.String });
const decodeFileDiff = Schema.decodeUnknownOption(FileDiffValue);

export type TranscriptEntry =
  | { readonly kind: "text"; readonly key: string; text: string }
  | { readonly kind: "reasoning"; readonly key: string; text: string }
  | {
      readonly kind: "tool";
      readonly key: string;
      readonly name: string;
      args: string;
      result: string | null;
      complete: boolean;
    }
  | { readonly kind: "diff"; readonly key: string; readonly path: string; diff: string }
  | { readonly kind: "error"; readonly key: string; readonly message: string };

interface TranscriptFold {
  readonly entries: TranscriptEntry[];
  readonly byKey: Map<string, TranscriptEntry>;
  appliedEventCount: number;
  lastSeq: number | null;
}

export const makeTranscriptFold = (): TranscriptFold => ({
  entries: [],
  byKey: new Map(),
  appliedEventCount: 0,
  lastSeq: null,
});

const transcriptToolKey = (toolCallId: string | null | undefined) => `tool:${toolCallId ?? ""}`;

const transcriptDiffKey = (path: string) => `diff:${path}`;

const append = (state: TranscriptFold, kind: "text" | "reasoning", key: string, delta: string) => {
  const existing = state.byKey.get(key);
  if (existing && (existing.kind === "text" || existing.kind === "reasoning")) {
    existing.text += delta;
    return;
  }
  const entry: TranscriptEntry = { kind, key, text: delta };
  state.byKey.set(key, entry);
  state.entries.push(entry);
};

const toolEntryFor = (state: TranscriptFold, toolCallId: string | null | undefined) => {
  const entry = state.byKey.get(transcriptToolKey(toolCallId));
  return entry?.kind === "tool" ? entry : null;
};

const setDiffEntry = (state: TranscriptFold, path: string, diff: string) => {
  const key = transcriptDiffKey(path);
  const existing = state.byKey.get(key);
  if (existing?.kind === "diff") {
    existing.diff = diff;
    return;
  }
  const entry: TranscriptEntry = { kind: "diff", key, path, diff };
  state.byKey.set(key, entry);
  state.entries.push(entry);
};

const foldTranscriptActivity = (state: TranscriptFold, activity: RunActivity) =>
  AgUiEvent.matchOrElse(
    activity.event,
    {
      TEXT_MESSAGE_CONTENT: ({ messageId, delta }) =>
        append(state, "text", `text:${messageId ?? "0"}`, delta ?? ""),
      REASONING_MESSAGE_CONTENT: ({ messageId, delta }) =>
        append(state, "reasoning", `reason:${messageId ?? "0"}`, delta ?? ""),
      TOOL_CALL_START: ({ toolCallId, toolCallName }) => {
        const key = transcriptToolKey(toolCallId);
        if (state.byKey.has(key)) return;
        const entry: TranscriptEntry = {
          kind: "tool",
          key,
          name: toolCallName ?? "tool",
          args: "",
          result: null,
          complete: false,
        };
        state.byKey.set(key, entry);
        state.entries.push(entry);
      },
      TOOL_CALL_ARGS: ({ toolCallId, delta }) => {
        const entry = toolEntryFor(state, toolCallId);
        if (!entry) return;
        entry.args += delta ?? "";
      },
      TOOL_CALL_END: ({ toolCallId, args }) => {
        const entry = toolEntryFor(state, toolCallId);
        if (!entry) return;
        if (entry.args === "" && args) entry.args = args;
        entry.complete = true;
      },
      TOOL_CALL_RESULT: ({ toolCallId, result, content }) => {
        const entry = toolEntryFor(state, toolCallId);
        if (!entry) return;
        entry.result = firstString(result, content);
        entry.complete = true;
      },
      CUSTOM: ({ name, value }) => {
        if (name !== FILE_DIFF_EVENT) return;
        const diff = Option.getOrNull(decodeFileDiff(value));
        if (!diff) return;
        setDiffEntry(state, diff.path, diff.diff);
      },
      RUN_ERROR: ({ message }) => {
        state.entries.push({
          kind: "error",
          key: `error:${activity.seq}`,
          message: message ?? "run error",
        });
      },
    },
    () => undefined,
  );

export const applyTranscriptActivities = (state: TranscriptFold, activities: ReadonlyArray<RunActivity>) => {
  for (const activity of activities) {
    if (state.lastSeq !== null && activity.seq <= state.lastSeq) continue;
    foldTranscriptActivity(state, activity);
    state.lastSeq = activity.seq;
    state.appliedEventCount += 1;
  }
  return state;
};

export const foldTranscript = (activities: ReadonlyArray<RunActivity>) => {
  const state = applyTranscriptActivities(makeTranscriptFold(), activities);
  return state.entries;
};

type ActivityResult = typeof runActivityAtom extends (id: RunId) => Atom.Atom<infer V> ? V : never;
type ActivityError = ActivityResult extends AsyncResult.AsyncResult<unknown, infer E> ? E : never;

interface TranscriptSnapshot {
  readonly done: boolean;
  readonly entries: ReadonlyArray<TranscriptEntry>;
  readonly appliedEventCount: number;
}

type TranscriptResult = AsyncResult.AsyncResult<TranscriptSnapshot, ActivityError>;

interface TranscriptCell {
  fold: TranscriptFold;
  source: ActivityResult | null;
  result: TranscriptResult;
}

const resetTranscriptCell = (cell: TranscriptCell, result: TranscriptResult) => {
  cell.fold = makeTranscriptFold();
  cell.result = result;
  return result;
};

const applyActivityResult = (cell: TranscriptCell, current: ActivityResult) => {
  if (current === cell.source) return cell.result;
  cell.source = current;
  if (current._tag === "Initial") {
    return resetTranscriptCell(cell, AsyncResult.initial<TranscriptSnapshot, ActivityError>(current.waiting));
  }
  if (current._tag === "Failure") {
    return resetTranscriptCell(
      cell,
      AsyncResult.failure<TranscriptSnapshot, ActivityError>(current.cause, {
        waiting: current.waiting,
      }),
    );
  }
  applyTranscriptActivities(cell.fold, current.value.items);
  cell.result = AsyncResult.success(
    {
      done: current.value.done,
      entries: cell.fold.entries,
      appliedEventCount: cell.fold.appliedEventCount,
    },
    current,
  );
  return cell.result;
};

const runTranscriptAtom = Atom.family((runId: RunId) => {
  const cell: TranscriptCell = {
    fold: makeTranscriptFold(),
    source: null,
    result: AsyncResult.initial(),
  };
  return Atom.map(runActivityAtom(runId), (result) => applyActivityResult(cell, result));
});

export function useRunTranscript(runId: RunId) {
  const atom = runTranscriptAtom(runId);
  const result = useAtomValue(atom);
  const pull = useAtomSet(atom);

  const pump = useCallback(
    (current: TranscriptResult) => {
      if (current._tag === "Success" && !current.waiting && !current.value.done) pull();
    },
    [pull],
  );

  useAtomSubscribe(atom, pump, { immediate: true });

  return result;
}
