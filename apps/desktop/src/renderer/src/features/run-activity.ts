import {
  type AgUiEvent,
  agUiTextDelta,
  type DaemonEvent,
  type RunActivity,
  type RunId,
  type RunSummary,
} from "@cogwork/contracts";
import { useAtomSet, useAtomSubscribe, useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Atom from "effect/unstable/reactivity/Atom";
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

const compact = (value: unknown) => {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return JSON.stringify(value) ?? "";
};

const resultText = (event: AgUiEvent) => compact(event.result ?? event.content);

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

const toolKey = (runId: string, event: AgUiEvent) => `${runId}:${event.toolCallId ?? ""}`;

const entryFor = (state: RunPreviewState, runId: string): PreviewEntry =>
  state.get(runId) ?? { preview: { label: "starting", text: "" }, text: null, tools: new Map() };

const setPreview = (
  state: RunPreviewState,
  runId: string,
  entry: PreviewEntry,
  label: string,
  text: string,
) => new Map(state).set(runId, { ...entry, preview: { label, text: clip(oneLine(text)) } });

const onRunStarted = (state: RunPreviewState, { runId }: RunActivity) =>
  setPreview(state, runId, entryFor(state, runId), "starting", "");

const onText = (state: RunPreviewState, { runId, event, correlation }: RunActivity) => {
  const entry = entryFor(state, runId);
  const messageId = event.messageId ?? correlation.messageId ?? null;
  const previous = entry.text;
  const base = previous?.messageId === messageId ? previous.text : "";
  const text = base.length >= maxTextLength ? base : base + agUiTextDelta(event);
  const next = setPreview(state, runId, entry, "responding", text);
  return new Map(next).set(runId, { ...entryFor(next, runId), text: { messageId, text } });
};

const onToolStart = (state: RunPreviewState, { runId, event }: RunActivity) => {
  const entry = entryFor(state, runId);
  const name = event.toolCallName ?? "tool";
  const next = setPreview(state, runId, entry, name, "");
  return new Map(next).set(runId, {
    ...entryFor(next, runId),
    tools: new Map(entry.tools).set(toolKey(runId, event), name),
  });
};

const onToolEnd = (state: RunPreviewState, { runId, event }: RunActivity) => {
  const entry = entryFor(state, runId);
  const name = entry.tools.get(toolKey(runId, event)) ?? event.toolCallName ?? "tool";
  return setPreview(state, runId, entry, name, resultText(event));
};

const onStep = (state: RunPreviewState, { runId, event }: RunActivity) => {
  if (!event.stepName) return state;
  return setPreview(state, runId, entryFor(state, runId), "step", event.stepName);
};

const onCustom = (state: RunPreviewState, { runId, event }: RunActivity) => {
  if (event.name?.endsWith(".session-id")) return state;
  return setPreview(state, runId, entryFor(state, runId), event.name ?? "custom", compact(event.value));
};

const onRunFinished = (state: RunPreviewState, { runId, event }: RunActivity) =>
  setPreview(state, runId, entryFor(state, runId), "finished", event.finishReason ?? "");

const onRunError = (state: RunPreviewState, { runId, event }: RunActivity) =>
  setPreview(state, runId, entryFor(state, runId), "error", event.message ?? "run error");

const previewHandlers = new Map<string, (state: RunPreviewState, activity: RunActivity) => RunPreviewState>([
  ["RUN_STARTED", onRunStarted],
  ["TEXT_MESSAGE_CONTENT", onText],
  ["TOOL_CALL_START", onToolStart],
  ["TOOL_CALL_END", onToolEnd],
  ["TOOL_CALL_RESULT", onToolEnd],
  ["STEP_STARTED", onStep],
  ["CUSTOM", onCustom],
  ["RUN_FINISHED", onRunFinished],
  ["RUN_ERROR", onRunError],
]);

export const applyRunPreview = (state: RunPreviewState, activity: RunActivity) =>
  previewHandlers.get(activity.event.type)?.(state, activity) ?? state;

export const previewMap = (state: RunPreviewState): ReadonlyMap<string, RunActivityPreview> =>
  new Map([...state].map(([runId, entry]) => [runId, entry.preview]));

export const withoutRunPreview = (state: RunPreviewState, runId: string) => {
  if (!state.has(runId)) return state;
  const next = new Map(state);
  next.delete(runId);
  return next;
};

export const runPreviews = (events: ReadonlyArray<DaemonEvent>): ReadonlyMap<string, RunActivityPreview> => {
  const fold = events.reduce<RunPreviewState>(
    (state, event) => (event._tag === "RunActivity" ? applyRunPreview(state, event.activity) : state),
    new Map<string, PreviewEntry>(),
  );
  return previewMap(fold);
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
}

const stringify = (value: unknown) => {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? "";
};

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

type TranscriptHandler = (state: TranscriptFold, event: AgUiEvent, activity: RunActivity) => void;

const transcriptHandlers: Record<string, TranscriptHandler> = {
  TEXT_MESSAGE_CONTENT: (state, event) =>
    append(state, "text", `text:${event.messageId ?? "0"}`, event.delta ?? ""),
  REASONING_MESSAGE_CONTENT: (state, event) =>
    append(state, "reasoning", `reason:${event.messageId ?? "0"}`, event.delta ?? ""),
  TOOL_CALL_START: (state, event) => {
    const key = `tool:${event.toolCallId ?? ""}`;
    if (state.byKey.has(key)) return;
    const entry: TranscriptEntry = {
      kind: "tool",
      key,
      name: event.toolCallName ?? "tool",
      args: "",
      result: null,
      complete: false,
    };
    state.byKey.set(key, entry);
    state.entries.push(entry);
  },
  TOOL_CALL_ARGS: (state, event) => {
    const entry = state.byKey.get(`tool:${event.toolCallId ?? ""}`);
    if (entry?.kind === "tool") entry.args += event.delta ?? "";
  },
  TOOL_CALL_END: (state, event) => {
    const entry = state.byKey.get(`tool:${event.toolCallId ?? ""}`);
    if (entry?.kind !== "tool") return;
    if (entry.args === "" && event.args) entry.args = event.args;
    entry.complete = true;
  },
  TOOL_CALL_RESULT: (state, event) => {
    const entry = state.byKey.get(`tool:${event.toolCallId ?? ""}`);
    if (entry?.kind === "tool") {
      entry.result = stringify(event.result ?? event.content);
      entry.complete = true;
    }
  },
  CUSTOM: (state, event) => {
    if (event.name !== FILE_DIFF_EVENT) return;
    const diff = Option.getOrNull(decodeFileDiff(event.value));
    if (!diff) return;
    const key = `diff:${diff.path}`;
    const existing = state.byKey.get(key);
    if (existing?.kind === "diff") {
      existing.diff = diff.diff;
      return;
    }
    const entry: TranscriptEntry = { kind: "diff", key, path: diff.path, diff: diff.diff };
    state.byKey.set(key, entry);
    state.entries.push(entry);
  },
  RUN_ERROR: (state, event, activity) =>
    state.entries.push({
      kind: "error",
      key: `error:${activity.seq}`,
      message: event.message ?? "run error",
    }),
};

export const foldTranscript = (activities: ReadonlyArray<RunActivity>) => {
  const state: TranscriptFold = { entries: [], byKey: new Map() };
  for (const activity of activities)
    transcriptHandlers[activity.event.type]?.(state, activity.event, activity);
  return state.entries;
};

export const statusLine = (
  activities: ReadonlyArray<RunActivity>,
  status: RunSummary["status"] = "running",
) => {
  if (status === "succeeded") return "Run finished.";
  if (status === "failed" || status === "crashed" || status === "exhausted") return "Run failed.";
  if (status === "interrupted") return "Run interrupted.";

  const names = new Map<string, string>();
  const latest = activities.at(-1);
  if (!latest) return "Thinking…";

  for (const activity of activities) {
    if (activity.event.type !== "TOOL_CALL_START") continue;
    names.set(activity.event.toolCallId ?? "", activity.event.toolCallName ?? "tool");
  }

  const { event } = latest;
  if (event.type === "REASONING_MESSAGE_CONTENT") return "Thinking…";
  if (event.type === "TEXT_MESSAGE_CONTENT") return "Responding…";
  if (event.type === "TOOL_CALL_START") return `Running ${event.toolCallName ?? "tool"}…`;
  if (event.type === "TOOL_CALL_ARGS") return `Running ${names.get(event.toolCallId ?? "") ?? "tool"}…`;
  if (event.type === "TOOL_CALL_END" || event.type === "TOOL_CALL_RESULT") {
    return `Ran ${names.get(event.toolCallId ?? "") ?? event.toolCallName ?? "tool"}`;
  }
  if (event.type === "RUN_FINISHED") return "Run finished.";
  if (event.type !== "CUSTOM" || event.name !== FILE_DIFF_EVENT) return "Thinking…";

  const diff = Option.getOrNull(decodeFileDiff(event.value));
  return diff ? `Editing ${diff.path}` : "Thinking…";
};

type ActivityResult = typeof runActivityAtom extends (id: RunId) => Atom.Atom<infer V> ? V : never;

export function useRunActivity(runId: RunId) {
  const atom = runActivityAtom(runId);
  const result = useAtomValue(atom);
  const pull = useAtomSet(atom);

  // Mirrors use-live-events: a stable callback keeps useAtomSubscribe from re-subscribing each pull.
  const pump = useCallback(
    (current: ActivityResult) => {
      if (current._tag === "Success" && !current.waiting && !current.value.done) pull();
    },
    [pull],
  );

  useAtomSubscribe(atom, pump, { immediate: true });

  return result;
}
