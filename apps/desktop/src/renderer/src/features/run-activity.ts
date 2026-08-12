import { type AgUiEvent, agUiTextDelta, type DaemonEvent, type RunActivity } from "@clanker-forge/contracts";

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

interface Fold {
  readonly previews: Map<string, RunActivityPreview>;
  readonly texts: Map<string, TextBuffer>;
  readonly tools: Map<string, string>;
}

const toolKey = (runId: string, event: AgUiEvent) => `${runId}:${event.toolCallId ?? ""}`;

const setPreview = (fold: Fold, runId: string, label: string, text: string) => {
  fold.previews.set(runId, { label, text: clip(oneLine(text)) });
};

type Handler = (fold: Fold, activity: RunActivity) => void;

const onRunStarted: Handler = (fold, { runId }) => setPreview(fold, runId, "starting", "");

const onText: Handler = (fold, { runId, event, correlation }) => {
  const messageId = event.messageId ?? correlation.messageId ?? null;
  const previous = fold.texts.get(runId);
  const base = previous?.messageId === messageId ? previous.text : "";
  const text = base.length >= maxTextLength ? base : base + agUiTextDelta(event);
  fold.texts.set(runId, { messageId, text });
  setPreview(fold, runId, "responding", text);
};

const onToolStart: Handler = (fold, { runId, event }) => {
  const name = event.toolCallName ?? "tool";
  fold.tools.set(toolKey(runId, event), name);
  setPreview(fold, runId, name, "");
};

const onToolEnd: Handler = (fold, { runId, event }) => {
  const name = fold.tools.get(toolKey(runId, event)) ?? event.toolCallName ?? "tool";
  setPreview(fold, runId, name, resultText(event));
};

const onStep: Handler = (fold, { runId, event }) => {
  if (!event.stepName) return;
  setPreview(fold, runId, "step", event.stepName);
};

const onCustom: Handler = (fold, { runId, event }) => {
  if (event.name?.endsWith(".session-id")) return;
  setPreview(fold, runId, event.name ?? "custom", compact(event.value));
};

const onRunFinished: Handler = (fold, { runId, event }) =>
  setPreview(fold, runId, "finished", event.finishReason ?? "");

const onRunError: Handler = (fold, { runId, event }) =>
  setPreview(fold, runId, "error", event.message ?? "run error");

const handlers = new Map<string, Handler>([
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
  const fold: Fold = { previews: new Map(), texts: new Map(), tools: new Map() };
  for (const event of events) {
    if (event._tag !== "RunActivity") continue;
    handlers.get(event.activity.event.type)?.(fold, event.activity);
  }
  return fold.previews;
};
