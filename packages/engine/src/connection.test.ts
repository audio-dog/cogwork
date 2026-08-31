import {
  Connection,
  type ConnectionId,
  type ConnectionReadiness,
  connectionIdOf,
  defaultControlStore,
} from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import { ConnectionStore, connectionOverview, layer, requiringPluginId } from "./connection";
import { ControlStore, type ControlStoreService } from "./control-store";
import { CredentialStore, type CredentialStoreService } from "./credential-store";

const github = Connection.make({
  id: connectionIdOf("github", "default"),
  system: "github",
  account: "default",
  status: "established",
});

class RemovedConnections extends Context.Service<RemovedConnections, Ref.Ref<ReadonlyArray<ConnectionId>>>()(
  "@cogwork/engine/connection.test/RemovedConnections",
) {
  static readonly layer = Layer.effect(RemovedConnections, Ref.make<ReadonlyArray<ConnectionId>>([]));
}

const controlStoreLayer = Layer.succeed(ControlStore, {
  health: "available",
  seed: defaultControlStore,
  picture: Effect.succeed(defaultControlStore),
  setDaemonLimit: () => Effect.succeed(defaultControlStore),
  establishConnection: () => Effect.succeed(defaultControlStore),
  revokeConnection: () => Effect.succeed(defaultControlStore),
  removeConnection: () => Effect.succeed(defaultControlStore),
  updateOperationSetting: () => Effect.succeed(defaultControlStore),
  installPlugin: () => Effect.succeed(defaultControlStore),
  uninstallPlugin: () => Effect.succeed(defaultControlStore),
  updateContributionSetting: () => Effect.succeed(defaultControlStore),
  withWrite: (effect) => effect,
} satisfies ControlStoreService);

describe("Connection overview", () => {
  it("renders an established Connection with no Plugin as ready", () => {
    const overview = connectionOverview(
      [github],
      { plugins: [] },
      new Map([[github.id, { _tag: "Ready" } satisfies ConnectionReadiness]]),
    );

    const card = overview.connections.find((item) => item.system === "github");
    assert.strictEqual(card?.connection?.id, "github/default");
    assert.strictEqual(card?.readiness._tag, "Ready");
    assert.isNull(card?.pluginId ?? null);
  });

  it("derives the one Plugin requiring a system", () => {
    assert.strictEqual(
      requiringPluginId(
        {
          plugins: [
            {
              pluginId: "linear",
              name: "Linear",
              summary: "Linear tools",
              record: null,
              resolvedIdentity: "linear@1",
              requiredConnections: ["linear"],
              contributions: [],
              manifestFailure: null,
            },
          ],
        },
        "linear",
      ),
      "linear",
    );
  });
});

describe("Connection establishment", () => {
  it.effect("does not revalidate or remove a configured credential", () =>
    Effect.gen(function* () {
      const connections = yield* ConnectionStore;
      const connection = yield* connections.establish({
        system: "linear",
        account: "acme",
        source: { _tag: "ApiKey", key: Redacted.make("valid") },
      });

      assert.strictEqual(connection.id, connectionIdOf("linear", "acme"));
      assert.deepStrictEqual(yield* Ref.get(yield* RemovedConnections), []);
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(controlStoreLayer),
          Layer.provideMerge(
            Layer.effect(
              CredentialStore,
              Effect.gen(function* () {
                const removed = yield* RemovedConnections;
                return {
                  bearerToken: () => Effect.die("unexpected credential read"),
                  persist: () => Effect.die("unexpected credential persist"),
                  invalidate: () => Effect.void,
                  providerKey: () => Effect.die("unexpected provider key"),
                  persistProviderKey: () => Effect.die("unexpected provider key persist"),
                  configureConnection: () => Effect.void,
                  removeConnection: (connectionId) =>
                    Ref.update(removed, (current) => [...current, connectionId]),
                } satisfies CredentialStoreService;
              }),
            ).pipe(Layer.provideMerge(RemovedConnections.layer)),
          ),
        ),
      ),
    ),
  );
});
