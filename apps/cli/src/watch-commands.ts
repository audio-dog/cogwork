import {
  applyDaemonEvent,
  type Board,
  type DaemonEvent,
  initialBoard,
  type RunActivity,
  RunId,
  RunWatchItem,
  WorkItemId,
} from "@cogwork/contracts";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { RpcClientError } from "effect/rpc/RpcClientError";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { SocketErrorReason } from "effect/socket/Socket";
import * as Stream from "effect/Stream";

import { overSocket, socketFlag } from "./commands";
import { type DaemonRpcTimeout, makeDaemonClient } from "./rpc";
import { flushWatch, initialWatchState, renderBoard, stepWatch } from "./watch";

const watchIdFlag = Flag.String("id").pipe(
  Flag.withDescription("Follow a single run id directly"),
  Flag.optional,
);

const watchWorkItemArg = Argument.String("work-item").pipe(
  Argument.withDescription("Work item to watch; resolves to its running run, else its most recent run"),
  Argument.optional,
);

const markSeen = (seen: Ref.Ref<ReadonlyMap<string, number>>) => (activity: RunActivity) =>
  Ref.modify(seen, (map) => {
    const last = map.get(activity.runId) ?? -1;
    if (activity.seq <= last) return [false, map] as const;
    return [true, new Map(map).set(activity.runId, activity.seq)] as const;
  });

type WatchRpcError = DaemonRpcTimeout | RpcClientError;

const isWatchTransportError = (error: WatchRpcError) =>
  Schema.is(RpcClientError)(error) && Schema.is(SocketErrorReason)(error.reason);

export const watchReconnectBackoff = Schedule.exponential("500 millis", 2).pipe(
  Schedule.jittered,
  Schedule.modifyDelay(({ duration }) => Effect.succeed(Duration.min(duration, Duration.seconds(10)))),
  Schedule.setInputType<WatchRpcError>(),
  Schedule.while(({ input }) => isWatchTransportError(input)),
);

const clearScreen = "\u001b[2J\u001b[H";

type WatchPayload = { readonly id: RunId };

export const withWatchReconnect = <A, R>(stream: Stream.Stream<A, WatchRpcError, R>) =>
  stream.pipe(
    Stream.tapError((error) =>
      isWatchTransportError(error)
        ? Console.error(`watch: connection lost, reconnecting… (${String(error)})`)
        : Effect.void,
    ),
    Stream.retry(watchReconnectBackoff),
  );

const watchStream = (
  source: Stream.Stream<RunWatchItem, WatchRpcError>,
  seen: Ref.Ref<ReadonlyMap<string, number>>,
) =>
  withWatchReconnect(
    source.pipe(
      Stream.filter(RunWatchItem.guards.RunActivity),
      Stream.map((item) => item.activity),
      Stream.filterEffect(markSeen(seen)),
    ),
  );

const overviewScreen = (board: Board) => `${clearScreen}${renderBoard(board).join("\n")}`;

const watchOverview = (source: Stream.Stream<DaemonEvent, WatchRpcError>) =>
  withWatchReconnect(source.pipe(Stream.scan(() => initialBoard, applyDaemonEvent))).pipe(
    Stream.runForEach((board) => Console.log(overviewScreen(board))),
  );

export const resolveTarget = Effect.fn("commands.resolveTarget")(function* <E, R>(
  resolve: (workItem: WorkItemId) => Effect.Effect<RunId | null, E, R>,
  id: Option.Option<string>,
  workItem: Option.Option<string>,
) {
  if (Option.isSome(id)) {
    return Option.some<WatchPayload>({ id: yield* Schema.decodeEffect(RunId)(id.value) });
  }
  if (Option.isNone(workItem)) return Option.none<WatchPayload>();
  const item = yield* Schema.decodeEffect(WorkItemId)(workItem.value);
  const runId = yield* resolve(item);
  return runId === null ? Option.none<WatchPayload>() : Option.some<WatchPayload>({ id: runId });
});

const runWatch = Effect.fn("commands.runWatch")(
  function* (options: {
    readonly socketPath: string;
    readonly id: Option.Option<string>;
    readonly workItem: Option.Option<string>;
  }) {
    const client = yield* makeDaemonClient();
    if (Option.isNone(options.id) && Option.isNone(options.workItem)) {
      return yield* watchOverview(client.WatchEvents());
    }
    const target = yield* resolveTarget(
      (workItem) => client.ResolveWatchTarget({ workItem }),
      options.id,
      options.workItem,
    );
    if (Option.isNone(target)) {
      const item = Option.getOrElse(options.workItem, () => "");
      return yield* Console.error(`watch: no runs found for ${item}`);
    }
    const seen = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
    yield* watchStream(client.WatchActivity(target.value), seen).pipe(
      Stream.mapAccum(() => initialWatchState, stepWatch, { onHalt: flushWatch }),
      Stream.runForEach(Console.log),
    );
  },
  (effect, options) => overSocket(effect, options.socketPath),
);

export const watchCommand = Command.make("watch", {
  socket: socketFlag,
  id: watchIdFlag,
  workItem: watchWorkItemArg,
}).pipe(Command.withHandler(({ socket, id, workItem }) => runWatch({ socketPath: socket, id, workItem })));
