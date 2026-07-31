import type { HarnessEvent, RunActivity } from "@clanker-forge/contracts";

interface RunBuffer {
  readonly label: string;
  readonly text: string;
}

export interface WatchState {
  readonly buffers: ReadonlyMap<string, RunBuffer>;
}

export const initialWatchState: WatchState = { buffers: new Map() };

const maxLineLength = 140;

const controlChars = /\p{Cc}/gu;

const clip = (text: string) => {
  const collapsed = text.replace(controlChars, " ").replace(/\s+/g, " ").trim();
  return collapsed.length > maxLineLength ? `${collapsed.slice(0, maxLineLength - 1)}…` : collapsed;
};

const flushLine = (buffer: RunBuffer) => `${buffer.label} · ${clip(buffer.text)}`;

const setBuffer = (state: WatchState, runId: string, buffer: RunBuffer) => {
  const entry: readonly [string, RunBuffer] = [runId, buffer];
  return { buffers: new Map([...state.buffers, entry]) };
};

const clearBuffer = (state: WatchState, runId: string) => ({
  buffers: new Map([...state.buffers].filter(([key]) => key !== runId)),
});

const finishSummary = (event: HarnessEvent) => {
  const reason = event.finishReason ?? "finished";
  const total = event.usage?.totalTokens;
  return total === undefined ? reason : `${reason} (${total} tokens)`;
};

const eventLines = (label: string, event: HarnessEvent) => {
  if (event.type === "TOOL_CALL_START") return [`${label} · $ ${clip(event.name ?? "tool")}`];
  if (event.type === "RUN_STARTED") return [`${label} · run started`];
  if (event.type === "RUN_FINISHED") return [`${label} · run ${clip(finishSummary(event))}`];
  return [];
};

export const stepWatch = (
  state: WatchState,
  activity: RunActivity,
): readonly [WatchState, ReadonlyArray<string>] => {
  const { runId, event } = activity;
  const label = `${activity.stage} ${activity.workItem}`;

  if (event.type === "TEXT_MESSAGE_CONTENT") {
    const text = (state.buffers.get(runId)?.text ?? "") + (event.text ?? "");
    return [setBuffer(state, runId, { label, text }), []];
  }

  const pending = state.buffers.get(runId);
  const flushed = pending ? [flushLine(pending)] : [];
  return [clearBuffer(state, runId), [...flushed, ...eventLines(label, event)]];
};

export const flushWatch = (state: WatchState) => [...state.buffers.values()].map(flushLine);
