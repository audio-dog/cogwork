import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import { DaemonStatus } from "./daemon";

export const GetStatus = Rpc.make("GetStatus", { success: DaemonStatus });

export const DaemonRpcs = RpcGroup.make(GetStatus);
