import {
  AgUiEvent,
  agUiIsSessionHandleEvent,
  agUiIsSubagentEvent,
  type Board,
  type BoardItem,
  type RunActivity,
  type RunSummary,
  type SchedulerStats,
} from "@cogwork/contracts";
import { formatReadModelItem } from "./read-model-item";
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

type NamedEvent<Type extends string> = Extract<AgUiEvent, { readonly type: Type }>;

const finishSummary = (event: NamedEvent<"RUN_FINISHED">) => {
  const reason = sanitizeTerminalText(event.finishReason ?? "finished");
  const usage = event.usage;
  if (usage?.totalTokens === undefined) return `■ run ${reason}`;
  return `■ run ${reason} (${usage.estimated ? "~" : ""}${usage.totalTokens} tokens)`;
};

interface Ctx<Event extends AgUiEvent> {
  readonly state: WatchState;
  readonly runId: string;
  readonly label: string;
  readonly event: Event;
}

type Handler<Event extends AgUiEvent> = (ctx: Ctx<Event>) => readonly [WatchState, ReadonlyArray<string>];

const runStarted = (state: WatchState, label: string): readonly [WatchState, ReadonlyArray<string>] => [
  state,
  [line(label, "▶ run started")],
];

const toolStart: Handler<NamedEvent<"TOOL_CALL_START">> = ({ state, label, event }) => {
  const id = event.toolCallId ?? "";
  const name = sanitizeTerminalText(event.toolCallName ?? "tool");
  return [setTool(state, id, ""), [line(label, `⚙ ${name}`)]];
};

const toolArgs: Handler<NamedEvent<"TOOL_CALL_ARGS">> = ({ state, event }) => {
  const id = event.toolCallId ?? "";
  const pending = state.tools.get(id);
  if (pending === undefined) return [state, []];
  return [setTool(state, id, clip(pending + (event.delta ?? ""))), []];
};

type ToolResultEvent = NamedEvent<"TOOL_CALL_END"> | NamedEvent<"TOOL_CALL_RESULT">;

const resultLines = (label: string, event: ToolResultEvent) => {
  const result = compact(event.result ?? event.content);
  return result.length > 0 ? [line(label, `  → ${clip(result)}`)] : [];
};

const toolEnd: Handler<NamedEvent<"TOOL_CALL_END">> = ({ state, label, event }) => {
  const id = event.toolCallId ?? "";
  const args = (state.tools.get(id) || event.args) ?? "";
  const argLines = args.length > 0 ? [line(label, `  args ${clip(compact(args))}`)] : [];
  return [dropTool(state, id), [...argLines, ...resultLines(label, event)]];
};

const toolResult: Handler<NamedEvent<"TOOL_CALL_RESULT">> = ({ state, label, event }) => [
  state,
  resultLines(label, event),
];

const custom: Handler<NamedEvent<"CUSTOM">> = ({ state, label, event }) => {
  if (agUiIsSessionHandleEvent(event)) return [state, []];
  const name = sanitizeTerminalText(event.name ?? "custom");
  const detail = clip(compact(event.value));
  const body = detail.length > 0 ? `✎ ${name} ${detail}` : `✎ ${name}`;
  return [state, [line(label, body)]];
};

const step: Handler<NamedEvent<"STEP_STARTED">> = ({ state, label, event }) =>
  event.stepName ? [state, [line(label, `▸ ${sanitizeTerminalText(event.stepName)}`)]] : [state, []];

const runFinished: Handler<NamedEvent<"RUN_FINISHED">> = ({ state, label, event }) => [
  state,
  [line(label, finishSummary(event))],
];

const runError: Handler<NamedEvent<"RUN_ERROR">> = ({ state, label, event }) => [
  state,
  [line(label, `✖ ${sanitizeTerminalText(event.message ?? "run error")}`)],
];

const ignore = (state: WatchState): readonly [WatchState, ReadonlyArray<string>] => [state, []];

export const stepWatch = (
  state: WatchState,
  activity: RunActivity,
): readonly [WatchState, ReadonlyArray<string>] => {
  const { runId, event } = activity;
  if (agUiIsSubagentEvent(event)) return [state, []];
  const label = sanitizeTerminalText(`${activity.operation} ${activity.workItem}`);
  if (AgUiEvent.guards.TEXT_MESSAGE_CONTENT(event)) {
    const text = (state.text.get(runId)?.text ?? "") + (event.delta ?? "");
    return [setText(state, runId, { label, text }), []];
  }
  const [flushed, flushedLines] = flushText(state, runId);
  const context = { state: flushed, runId, label };
  const [next, lines] = AgUiEvent.matchOrElse(
    event,
    {
      RUN_STARTED: () => runStarted(flushed, label),
      TEXT_MESSAGE_START: () => ignore(flushed),
      TEXT_MESSAGE_CONTENT: () => ignore(flushed),
      TEXT_MESSAGE_END: () => ignore(flushed),
      REASONING_MESSAGE_CONTENT: () => ignore(flushed),
      TOOL_CALL_START: (event) => toolStart({ ...context, event }),
      TOOL_CALL_ARGS: (event) => toolArgs({ ...context, event }),
      TOOL_CALL_END: (event) => toolEnd({ ...context, event }),
      TOOL_CALL_RESULT: (event) => toolResult({ ...context, event }),
      CUSTOM: (event) => custom({ ...context, event }),
      STEP_STARTED: (event) => step({ ...context, event }),
      STEP_FINISHED: () => ignore(flushed),
      RUN_FINISHED: (event) => runFinished({ ...context, event }),
      RUN_ERROR: (event) => runError({ ...context, event }),
    },
    () => ignore(flushed),
  );
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
      .map((entry) => `    ${terminalLine(formatReadModelItem(entry.item))}`),
  ]);

const runningLine = (run: RunSummary) =>
  `  ${terminalLine(`${run.operation} ${run.workItem} [${run.harness}] ${run.id}`)}`;

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
