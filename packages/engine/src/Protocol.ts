import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

export const WorkspaceInfo = Schema.Struct({
  name: Schema.String,
  checkoutPath: Schema.String,
  workSource: Schema.String,
  harness: Schema.String,
});
export type WorkspaceInfo = typeof WorkspaceInfo.Type;

export const RegistrationFailureInfo = Schema.Struct({
  source: Schema.String,
  message: Schema.String,
});
export type RegistrationFailureInfo = typeof RegistrationFailureInfo.Type;

export const DaemonStatus = Schema.Struct({
  health: Schema.Literals(["running"]),
  startedAtMillis: Schema.Finite,
  uptimeMillis: Schema.Finite,
  workspaces: Schema.Array(WorkspaceInfo),
  failures: Schema.Array(RegistrationFailureInfo),
});
export type DaemonStatus = typeof DaemonStatus.Type;

export const DaemonRpcs = RpcGroup.make(Rpc.make("GetStatus", { success: DaemonStatus }));
