import { DaemonRpcs } from "@clanker-forge/contracts";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import type { DaemonStatusResult } from "../shared/ipc";

const clientLayer = (socketPath: string) =>
  RpcClient.layerProtocolSocket().pipe(
    Layer.provide(NodeSocket.layerNet({ path: socketPath })),
    Layer.provide(RpcSerialization.layerNdjson),
  );

const fetchStatus = (socketPath: string) =>
  Effect.gen(function* () {
    const client = yield* RpcClient.make(DaemonRpcs);
    return yield* client.GetStatus();
  }).pipe(Effect.scoped, Effect.provide(clientLayer(socketPath)));

export const getDaemonStatus = (socketPath: string): Promise<DaemonStatusResult> =>
  fetchStatus(socketPath).pipe(
    Effect.matchCause({
      onFailure: (cause): DaemonStatusResult => ({ ok: false, message: Cause.pretty(cause) }),
      onSuccess: (status): DaemonStatusResult => ({ ok: true, status }),
    }),
    Effect.runPromise,
  );
