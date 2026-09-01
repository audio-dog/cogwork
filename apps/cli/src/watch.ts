import {
  type AgUiEvent,
  AgUiEventUnion,
  type Board,
  type BoardItem,
  type RunActivity,
  type RunSummary,
  type SchedulerStats,
} from "@cogwork/contracts";
import { formatClassifiedItem } from "./classified-item";
import { formatScheduler } from "./status";
import { sanitizeTerminalText, terminalLine } from "./terminal-text";

interface TextBuffer {
  readonly label: string;
  readonly text: string;
}

export interface WatchState {
  readonly text: ReadonlyMap<string, TextBuffer>;
  readonly tools: ReadonlyMap<string, string>;
}

export const initialWatchState: WatchState = { text: new Map(), tools: new Map() };

const maxValueLength = 2000;
const clip = (text: string) =>
  text.length > maxValueLength ? `${text.slice(0, maxValueLength - 1)}…` : text;

const compact = (value: unknown) => {
  if (typeof value === "string") return sanitizeTerminalText(value);
  return value === undefined ? "" : sanitizeTerminalText(JSON.stringify(value) ?? "");
};

const withEntry = <V>(map: ReadonlyMap<string, V>, key: string, value: V) =>
  new Map([...map, [key, value] as const]);

const without = <V>(map: ReadonlyMap<string, V>, key: string) =>
  new Map([...map].filter(([existing]) => existing !== key));

const setText = (state: WatchState, runId: string, buffer: TextBuffer) => ({
  ...state,
  text: withEntry(state.text, runId, buffer),
});

const dropText = (state: WatchState, runId: string) => ({
  ...state,
  text: without(state.text, runId),
});

const setTool = (state: WatchState, id: string, args: string) => ({
  ...state,
  tools: withEntry(state.tools, id, args),
});

const dropTool = (state: WatchState, id: string) => ({
  ...state,
  tools: without(state.tools, id),
});

const line = (label: string, body: string) => `${label} · ${body}`;

const textLines = (buffer: TextBuffer) => {
  const clean = sanitizeTerminalText(buffer.text).trim();
  if (clean.length === 0) return [];
  return clean
    .split("\n")
    .map((entry) => entry.trimEnd())
    .filter((entry) => entry.length > 0)
    .map((entry) => line(buffer.label, clip(entry)));
};

const flushText = (state: WatchState, runId: string): readonly [WatchState, ReadonlyArray<string>] => {
  const pending = state.text.get(runId);
  return pending ? [dropText(state, runId), textLines(pending)] : [state, []];
};

const finishSummary = (event: AgUiEvent) => {
  const reason = sanitizeTerminalText(event.finishReason ?? "finished");
  const usage = event.usage;
  if (usage?.totalTokens === undefined) return `■ run ${reason}`;
  return `■ run ${reason} (${usage.estimated ? "~" : ""}${usage.totalTokens} tokens)`;
};

interface Ctx {
  readonly state: WatchState;
  readonly runId: string;
  readonly label: string;
  readonly event: AgUiEvent;
}

type Handler = (ctx: Ctx) => readonly [WatchState, ReadonlyArray<string>];

const runStarted: Handler = ({ state, label }) => [state, [line(label, "▶ run started")]];

const toolStart: Handler = ({ state, label, event }) => {
  const id = event.toolCallId ?? "";
  const name = sanitizeTerminalText(event.toolCallName ?? "tool");
  return [setTool(state, id, ""), [line(label, `⚙ ${name}`)]];
};

const toolArgs: Handler = ({ state, event }) => {
  const id = event.toolCallId ?? "";
  const pending = state.tools.get(id);
  if (pending === undefined) return [state, []];
  return [setTool(state, id, clip(pending + (event.delta ?? ""))), []];
};

const resultText = (event: AgUiEvent) => compact(event.result ?? event.content);

const resultLines = (label: string, event: AgUiEvent) => {
  const result = resultText(event);
  return result.length > 0 ? [line(label, `  → ${clip(result)}`)] : [];
};

const toolEnd: Handler = ({ state, label, event }) => {
  const id = event.toolCallId ?? "";
  const args = (state.tools.get(id) || event.args) ?? "";
  const argLines = args.length > 0 ? [line(label, `  args ${clip(compact(args))}`)] : [];
  return [dropTool(state, id), [...argLines, ...resultLines(label, event)]];
};

const toolResult: Handler = ({ state, label, event }) => [state, resultLines(label, event)];

const custom: Handler = ({ state, label, event }) => {
  if (event.name?.endsWith(".session-id")) return [state, []];
  const name = sanitizeTerminalText(event.name ?? "custom");
  const detail = clip(compact(event.value));
  const body = detail.length > 0 ? `✎ ${name} ${detail}` : `✎ ${name}`;
  return [state, [line(label, body)]];
};

const step: Handler = ({ state, label, event }) =>
  event.stepName ? [state, [line(label, `▸ ${sanitizeTerminalText(event.stepName)}`)]] : [state, []];

const runFinished: Handler = ({ state, label, event }) => [state, [line(label, finishSummary(event))]];

const runError: Handler = ({ state, label, event }) => [
  state,
  [line(label, `✖ ${sanitizeTerminalText(event.message ?? "run error")}`)],
];

const ignore: Handler = ({ state }) => [state, []];

export const stepWatch = (
  state: WatchState,
  activity: RunActivity,
): readonly [WatchState, ReadonlyArray<string>] => {
  const { runId, event } = activity;
  const label = sanitizeTerminalText(`${activity.stage} ${activity.workItem}`);
  if (AgUiEventUnion.guards.TEXT_MESSAGE_CONTENT(event)) {
    const text = (state.text.get(runId)?.text ?? "") + (event.delta ?? "");
    return [setText(state, runId, { label, text }), []];
  }
  const [flushed, flushedLines] = flushText(state, runId);
  const handle = AgUiEventUnion.matchOrElse(
    event,
    {
      RUN_STARTED: () => runStarted,
      TEXT_MESSAGE_START: () => ignore,
      TEXT_MESSAGE_CONTENT: () => ignore,
      TEXT_MESSAGE_END: () => ignore,
      REASONING_MESSAGE_CONTENT: () => ignore,
      TOOL_CALL_START: () => toolStart,
      TOOL_CALL_ARGS: () => toolArgs,
      TOOL_CALL_END: () => toolEnd,
      TOOL_CALL_RESULT: () => toolResult,
      CUSTOM: () => custom,
      STEP_STARTED: () => step,
      STEP_FINISHED: () => ignore,
      RUN_FINISHED: () => runFinished,
      RUN_ERROR: () => runError,
    } satisfies Record<keyof typeof AgUiEventUnion.guards, unknown>,
    () => ignore,
  );
  const [next, lines] = handle({ state: flushed, runId, label, event });
  return [next, [...flushedLines, ...lines]];
};

export const flushWatch = (state: WatchState) =>
  [...state.text.values()].flatMap((buffer) => textLines(buffer));

const workspaceNames = (items: ReadonlyArray<BoardItem>) =>
  [...new Set(items.map((entry) => entry.workspace))].sort();

const workspaceLines = (items: ReadonlyArray<BoardItem>) =>
  workspaceNames(items).flatMap((name) => [
    `  ${terminalLine(name)}`,
    ...items
      .filter((entry) => entry.workspace === name)
      .map((entry) => `    ${terminalLine(formatClassifiedItem(entry.item))}`),
  ]);

const runningLine = (run: RunSummary) =>
  `  ${terminalLine(`${run.stage} ${run.workItem} [${run.harness}] ${run.id}`)}`;

const schedulerLine = (scheduler: SchedulerStats | null) =>
  scheduler ? formatScheduler(scheduler) : "scheduler: (pending)";

const group = (label: string, lines: ReadonlyArray<string>, empty: string) => [
  `${label}:`,
  ...(lines.length === 0 ? [`  ${empty}`] : lines),
];

export const renderBoard = (board: Board) => {
  const items = [...board.items.values()];
  const running = [...board.runs.values()].filter((run) => run.status === "running");
  return [
    schedulerLine(board.scheduler),
    ...group("workspaces", workspaceLines(items), "(no items)"),
    ...group("running", running.map(runningLine), "(no running runs)"),
  ];
};
