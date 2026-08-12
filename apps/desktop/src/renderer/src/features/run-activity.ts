import {
  type AgUiEvent,
  agUiTextDelta,
  type DaemonEvent,
  type RunActivity,
  type RunId,
} from "@clanker-forge/contracts";
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

interface PreviewFold {
  readonly previews: Map<string, RunActivityPreview>;
  readonly texts: Map<string, TextBuffer>;
  readonly tools: Map<string, string>;
}

const toolKey = (runId: string, event: AgUiEvent) => `${runId}:${event.toolCallId ?? ""}`;

const setPreview = (fold: PreviewFold, runId: string, label: string, text: string) => {
  fold.previews.set(runId, { label, text: clip(oneLine(text)) });
};

type PreviewHandler = (fold: PreviewFold, activity: RunActivity) => void;

const onRunStarted: PreviewHandler = (fold, { runId }) => setPreview(fold, runId, "starting", "");

const onText: PreviewHandler = (fold, { runId, event, correlation }) => {
  const messageId = event.messageId ?? correlation.messageId ?? null;
  const previous = fold.texts.get(runId);
  const base = previous?.messageId === messageId ? previous.text : "";
  const text = base.length >= maxTextLength ? base : base + agUiTextDelta(event);
  fold.texts.set(runId, { messageId, text });
  setPreview(fold, runId, "responding", text);
};

const onToolStart: PreviewHandler = (fold, { runId, event }) => {
  const name = event.toolCallName ?? "tool";
  fold.tools.set(toolKey(runId, event), name);
  setPreview(fold, runId, name, "");
};

const onToolEnd: PreviewHandler = (fold, { runId, event }) => {
  const name = fold.tools.get(toolKey(runId, event)) ?? event.toolCallName ?? "tool";
  setPreview(fold, runId, name, resultText(event));
};

const onStep: PreviewHandler = (fold, { runId, event }) => {
  if (!event.stepName) return;
  setPreview(fold, runId, "step", event.stepName);
};

const onCustom: PreviewHandler = (fold, { runId, event }) => {
  if (event.name?.endsWith(".session-id")) return;
  setPreview(fold, runId, event.name ?? "custom", compact(event.value));
};

const onRunFinished: PreviewHandler = (fold, { runId, event }) =>
  setPreview(fold, runId, "finished", event.finishReason ?? "");

const onRunError: PreviewHandler = (fold, { runId, event }) =>
  setPreview(fold, runId, "error", event.message ?? "run error");

const previewHandlers = new Map<string, PreviewHandler>([
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

export const runPreviews = (events: ReadonlyArray<DaemonEvent>): ReadonlyMap<string, RunActivityPreview> => {
  const fold: PreviewFold = { previews: new Map(), texts: new Map(), tools: new Map() };
  for (const event of events) {
    if (event._tag !== "RunActivity") continue;
    previewHandlers.get(event.activity.event.type)?.(fold, event.activity);
  }
  return fold.previews;
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
    if (entry?.kind === "tool" && entry.args === "" && event.args) entry.args = event.args;
  },
  TOOL_CALL_RESULT: (state, event) => {
    const entry = state.byKey.get(`tool:${event.toolCallId ?? ""}`);
    if (entry?.kind === "tool") entry.result = stringify(event.result ?? event.content);
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
