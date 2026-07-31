import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import { DaemonStatus } from "./daemon";
import { RunEvent, RunId, RunSummary } from "./run";

export const GetStatus = Rpc.make("GetStatus", { success: DaemonStatus });

export const ListRuns = Rpc.make("ListRuns", { success: Schema.Array(RunSummary) });

export const GetRunEvents = Rpc.make("GetRunEvents", {
  payload: { id: RunId },
  success: Schema.Array(RunEvent),
});

export const DaemonRpcs = RpcGroup.make(GetStatus, ListRuns, GetRunEvents);
