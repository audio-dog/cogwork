import type { AgUiEvent, RunActivity, RunId } from "@clanker-forge/contracts";
import { useAtomSet, useAtomSubscribe, useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Atom from "effect/unstable/reactivity/Atom";
import { useCallback } from "react";
import { runActivityAtom } from "../daemon/atoms";

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

interface FoldState {
  readonly entries: TranscriptEntry[];
  readonly byKey: Map<string, TranscriptEntry>;
}

const stringify = (value: unknown) => {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? "";
};

const append = (state: FoldState, kind: "text" | "reasoning", key: string, delta: string) => {
  const existing = state.byKey.get(key);
  if (existing && (existing.kind === "text" || existing.kind === "reasoning")) {
    existing.text += delta;
    return;
  }
  const entry: TranscriptEntry = { kind, key, text: delta };
  state.byKey.set(key, entry);
  state.entries.push(entry);
};

type Handler = (state: FoldState, event: AgUiEvent, activity: RunActivity) => void;

const handlers: Record<string, Handler> = {
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
  const state: FoldState = { entries: [], byKey: new Map() };
  for (const activity of activities) handlers[activity.event.type]?.(state, activity.event, activity);
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
