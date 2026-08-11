import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import { WorkItemId } from "./base-schemas";
import { DaemonStatus } from "./daemon";
import { PrincipalMiddleware } from "./principal";
import { RunActivity, RunEvent, RunId, RunSummary } from "./run";

export const GetStatus = Rpc.make("GetStatus", { success: DaemonStatus });

export const ListRuns = Rpc.make("ListRuns", { success: Schema.Array(RunSummary) });

export const GetRunEvents = Rpc.make("GetRunEvents", {
  payload: { id: RunId },
  success: Schema.Array(RunEvent),
});

export const ResolveWatchTarget = Rpc.make("ResolveWatchTarget", {
  payload: { workItem: WorkItemId },
  success: Schema.NullOr(RunId),
});

export const WatchActivity = Rpc.make("WatchActivity", {
  payload: { id: Schema.optional(RunId) },
  success: RunActivity,
  stream: true,
});

export const DaemonQueries = RpcGroup.make(
  GetStatus,
  ListRuns,
  GetRunEvents,
  ResolveWatchTarget,
  WatchActivity,
).middleware(PrincipalMiddleware);

export const DaemonCommands = RpcGroup.make();

export const DaemonRpcs = DaemonQueries.merge(DaemonCommands);
