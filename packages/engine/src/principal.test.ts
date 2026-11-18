import { localOwnerId, Principal, PrincipalMiddleware } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcTest from "effect/rpc/RpcTest";
import * as Schema from "effect/Schema";
import * as Daemon from "./daemon";

const WhoAmI = Rpc.make("WhoAmI", { success: Schema.String });

const guarded = RpcGroup.make(WhoAmI).middleware(PrincipalMiddleware);

const handlerLayer = guarded.toLayer({
  WhoAmI: Effect.fn("WhoAmI")(function* () {
    const principal = yield* Principal;
    return principal.id;
  }),
});

describe("principal seam", () => {
  it.effect("middleware injects the fixed local owner into a handler's context", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(guarded);
      assert.strictEqual(yield* client.WhoAmI(), localOwnerId);
    }).pipe(Effect.provide(Layer.mergeAll(handlerLayer, Daemon.principalMiddlewareLayer)), Effect.scoped),
  );
});
