import { type RunEvent, type RunHistory, RunId, type RunSummary } from "@cogwork/contracts";
import * as Console from "effect/Console";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { overSocket, socketFlag } from "./commands";
import { makeDaemonClient } from "./rpc";

const runIdFlag = Flag.String("id").pipe(Flag.withDescription("Run id to inspect"));

const usageLabel = (usage: RunSummary["usage"]) => {
  if (usage?.totalTokens === undefined) return "";
  return `  tokens=${usage.estimated ? "~" : ""}${usage.totalTokens}`;
};

const formatRun = (run: RunSummary) => {
  const session = run.session ? `  session=${run.session}` : "";
  const prunedHistoryLabel =
    run.eventsPrunedAtMillis === null ? "" : `  history-pruned=${run.eventsPrunedAtMillis}`;
  return `  ${run.id}  ${run.status}  ${run.operation}  ${run.workItem} [${run.harness}]  events=${run.eventCount}${prunedHistoryLabel}${session}${usageLabel(run.usage)}`;
};

const formatRuns = (runs: ReadonlyArray<RunSummary>) =>
  runs.length === 0 ? "(no runs recorded)" : ["runs:", ...runs.map(formatRun)].join("\n");

const formatEvent = (event: RunEvent) =>
  `  #${event.seq}  ${event.type}${event.name ? ` ${event.name}` : ""}  ${event.data}`;

export const formatRunEvents = (history: RunHistory) => {
  if (history.eventsPrunedAtMillis !== null) return `(run history pruned at ${history.eventsPrunedAtMillis})`;
  return history.events.length === 0
    ? "(no events for this run)"
    : history.events.map(formatEvent).join("\n");
};

const runRuns = Effect.fn("commands.runRuns")(
  function* (_options: { readonly socketPath: string }) {
    const client = yield* makeDaemonClient();
    const runs = yield* client.ListRuns();
    yield* Console.log(formatRuns(runs));
  },
  (effect, options) => overSocket(effect, options.socketPath),
);

const runMetrics = Effect.fn("commands.runMetrics")(
  function* (_options: { readonly socketPath: string }) {
    const client = yield* makeDaemonClient();
    const metrics = yield* client.GetMetrics();
    yield* Console.log(metrics === "" ? "(no metrics recorded)" : metrics);
  },
  (effect, options) => overSocket(effect, options.socketPath),
);

const runEvents = Effect.fn("commands.runEvents")(
  function* (options: { readonly socketPath: string; readonly id: string }) {
    const client = yield* makeDaemonClient();
    const id = yield* Schema.decodeEffect(RunId)(options.id);
    const history = yield* client.GetRunEvents({ id });
    yield* Console.log(formatRunEvents(history));
  },
  (effect, options) => overSocket(effect, options.socketPath),
);

export const runsCommand = Command.make("runs", { socket: socketFlag }).pipe(
  Command.withHandler(({ socket }) => runRuns({ socketPath: socket })),
);

export const metricsCommand = Command.make("metrics", { socket: socketFlag }).pipe(
  Command.withDescription("Dump live daemon metrics"),
  Command.withHandler(({ socket }) => runMetrics({ socketPath: socket })),
);

export const runEventsCommand = Command.make("run-events", { socket: socketFlag, id: runIdFlag }).pipe(
  Command.withHandler(({ socket, id }) => runEvents({ socketPath: socket, id })),
);
