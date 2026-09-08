import {
  Connection,
  type ConnectionId,
  type ConnectionReadiness,
  ControlStoreFailure,
  connectionIdOf,
  defaultControlStore,
  IssueTrackerError,
} from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import { ConnectionStore, connectionOverview, layer } from "./connection";
import { acceptingLayer as acceptingVerifierLayer, ConnectionVerifier } from "./connection-verify";
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

class ConfiguredCredentials extends Context.Service<
  ConfiguredCredentials,
  Ref.Ref<ReadonlyArray<ConnectionId>>
>()("@cogwork/engine/connection.test/ConfiguredCredentials") {
  static readonly layer = Layer.effect(ConfiguredCredentials, Ref.make<ReadonlyArray<ConnectionId>>([]));
}

class EstablishedConnections extends Context.Service<
  EstablishedConnections,
  Ref.Ref<ReadonlyArray<ConnectionId>>
>()("@cogwork/engine/connection.test/EstablishedConnections") {
  static readonly layer = Layer.effect(EstablishedConnections, Ref.make<ReadonlyArray<ConnectionId>>([]));
}

const controlStoreService = {
  health: "available",
  seed: defaultControlStore,
  picture: Effect.succeed(defaultControlStore),
  setDaemonLimit: () => Effect.succeed(defaultControlStore),
  establishConnection: () => Effect.succeed(defaultControlStore),
  revokeConnection: () => Effect.succeed(defaultControlStore),
  removeConnection: () => Effect.succeed(defaultControlStore),
  setHarnessEnabled: () => Effect.succeed(defaultControlStore),
  updateOperationSetting: () => Effect.succeed(defaultControlStore),
  installPlugin: () => Effect.succeed(defaultControlStore),
  uninstallPlugin: () => Effect.succeed(defaultControlStore),
  updateContributionSetting: () => Effect.succeed(defaultControlStore),
  withWrite: (effect) => effect,
} satisfies ControlStoreService;

const controlStoreLayer = Layer.succeed(ControlStore, controlStoreService);

// Every method a credential-store stub must carry but these tests never reach.
const unusedCredentialStore = {
  bearerToken: () => Effect.die("unexpected credential read"),
  resolveSource: () => Effect.die("unexpected credential source resolution"),
  persist: () => Effect.die("unexpected credential persist"),
  invalidate: () => Effect.void,
  providerKey: () => Effect.die("unexpected provider key"),
  persistProviderKey: () => Effect.die("unexpected provider key persist"),
  configureConnection: () => Effect.die("unexpected credential configure"),
  removeConnection: () => Effect.die("unexpected credential removal"),
} satisfies CredentialStoreService;

describe("Connection overview", () => {
  it("renders an established Connection as ready", () => {
    const overview = connectionOverview(
      [github],
      new Map([[github.id, { _tag: "Ready" } satisfies ConnectionReadiness]]),
    );

    const card = overview.connections.find((item) => item.system === "github");
    assert.strictEqual(card?.connection?.id, "github/default");
    assert.strictEqual(card?.readiness._tag, "Ready");
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
          Layer.provide(acceptingVerifierLayer),
          Layer.provideMerge(
            Layer.effect(
              CredentialStore,
              Effect.gen(function* () {
                const removed = yield* RemovedConnections;
                return {
                  bearerToken: () => Effect.die("unexpected credential read"),
                  resolveSource: () =>
                    Effect.succeed({
                      source: "stored-key" as const,
                      token: Redacted.make("valid"),
                      identity: null,
                    }),
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

// The bug this covers: `GITHUB_TOKEN=Hello` resolves to a non-empty string, so the old establish
// path stamped the Connection "established" and the card went green. Nothing asked GitHub.
const rejectingVerifier = Layer.succeed(ConnectionVerifier, {
  verify: () =>
    Effect.fail(new IssueTrackerError({ reason: "auth", message: "GitHub authentication failed (401)" })),
});

describe("Connection verification", () => {
  it.effect("refuses a credential the system rejects, and writes nothing", () =>
    Effect.gen(function* () {
      const connections = yield* ConnectionStore;
      const outcome = yield* Effect.flip(
        connections.establish({
          system: "github",
          source: { _tag: "ApiKey", key: Redacted.make("Hello") },
        }),
      );

      assert.strictEqual(outcome._tag, "ConnectionNotReady");
      assert.include(outcome.message, "401");
      // Neither store was touched: a re-connect that fails verification must leave the credential
      // it was replacing exactly as it was.
      assert.deepStrictEqual(yield* Ref.get(yield* ConfiguredCredentials), []);
      assert.deepStrictEqual(yield* Ref.get(yield* EstablishedConnections), []);
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(rejectingVerifier),
          Layer.provideMerge(
            Layer.effect(
              CredentialStore,
              Effect.gen(function* () {
                const configured = yield* ConfiguredCredentials;
                return {
                  ...unusedCredentialStore,
                  resolveSource: () =>
                    Effect.succeed({
                      source: "stored-key" as const,
                      token: Redacted.make("Hello"),
                      identity: null,
                    }),
                  configureConnection: (connectionId) =>
                    Ref.update(configured, (current) => [...current, connectionId]),
                } satisfies CredentialStoreService;
              }),
            ).pipe(Layer.provideMerge(ConfiguredCredentials.layer)),
          ),
          Layer.provideMerge(
            Layer.effect(
              ControlStore,
              Effect.gen(function* () {
                const established = yield* EstablishedConnections;
                return {
                  ...controlStoreService,
                  establishConnection: (connection) =>
                    Ref.update(established, (current) => [...current, connection.id]).pipe(
                      Effect.map(() => defaultControlStore),
                    ),
                } satisfies ControlStoreService;
              }),
            ).pipe(Layer.provideMerge(EstablishedConnections.layer)),
          ),
        ),
      ),
    ),
  );

  it.effect("uses the verified GitHub login as the Connection account", () =>
    Effect.gen(function* () {
      const connections = yield* ConnectionStore;
      const connection = yield* connections.establish({
        system: "github",
        source: { _tag: "GitHubCli" },
      });

      assert.strictEqual(connection.id, connectionIdOf("github", "octocat"));
      assert.strictEqual(connection.account, "octocat");
      assert.deepStrictEqual(yield* Ref.get(yield* ConfiguredCredentials), [connection.id]);
      assert.deepStrictEqual(yield* Ref.get(yield* EstablishedConnections), [connection.id]);
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(Layer.succeed(ConnectionVerifier, { verify: () => Effect.succeed("octocat") })),
          Layer.provideMerge(
            Layer.effect(
              CredentialStore,
              Effect.map(ConfiguredCredentials, (configured) => ({
                ...unusedCredentialStore,
                resolveSource: () =>
                  Effect.succeed({
                    source: "github-cli" as const,
                    token: Redacted.make("secret"),
                    identity: null,
                  }),
                configureConnection: (connectionId) =>
                  Ref.update(configured, (current) => [...current, connectionId]),
              })),
            ).pipe(Layer.provideMerge(ConfiguredCredentials.layer)),
          ),
          Layer.provideMerge(
            Layer.effect(
              ControlStore,
              Effect.map(EstablishedConnections, (established) => ({
                ...controlStoreService,
                establishConnection: (connection: Connection) =>
                  Ref.update(established, (current) => [...current, connection.id]).pipe(
                    Effect.map(() => defaultControlStore),
                  ),
              })),
            ).pipe(Layer.provideMerge(EstablishedConnections.layer)),
          ),
        ),
      ),
    ),
  );

  it.effect("refuses a different discovered account before replacing a re-connect source", () =>
    Effect.gen(function* () {
      const connections = yield* ConnectionStore;
      const failure = yield* Effect.flip(
        connections.establish({ system: "github", source: { _tag: "GitHubCli" } }, "fixed-account"),
      );

      assert.include(failure.message, 'Connection is established for "fixed-account"');
      assert.deepStrictEqual(yield* Ref.get(yield* ConfiguredCredentials), []);
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(Layer.succeed(ConnectionVerifier, { verify: () => Effect.succeed("other-account") })),
          Layer.provide(controlStoreLayer),
          Layer.provideMerge(
            Layer.effect(
              CredentialStore,
              Effect.map(ConfiguredCredentials, (configured) => ({
                ...unusedCredentialStore,
                resolveSource: () =>
                  Effect.succeed({
                    source: "github-cli" as const,
                    token: Redacted.make("secret"),
                    identity: null,
                  }),
                configureConnection: (connectionId) =>
                  Ref.update(configured, (current) => [...current, connectionId]),
              })),
            ).pipe(Layer.provideMerge(ConfiguredCredentials.layer)),
          ),
        ),
      ),
    ),
  );

  it.effect("keeps the re-connect source when the Control store write fails", () =>
    Effect.gen(function* () {
      const connections = yield* ConnectionStore;
      const failure = yield* Effect.flip(
        connections.establish({ system: "github", source: { _tag: "GitHubCli" } }, "octocat"),
      );

      assert.strictEqual(failure._tag, "ConnectionFailure");
      assert.deepStrictEqual(yield* Ref.get(yield* ConfiguredCredentials), []);
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(Layer.succeed(ConnectionVerifier, { verify: () => Effect.succeed("octocat") })),
          Layer.provide(
            Layer.succeed(ControlStore, {
              ...controlStoreService,
              picture: Effect.succeed({
                ...defaultControlStore,
                connections: [
                  Connection.make({
                    id: connectionIdOf("github", "octocat"),
                    system: "github",
                    account: "octocat",
                    status: "established",
                  }),
                ],
              }),
              establishConnection: () =>
                Effect.fail(ControlStoreFailure.make({ operation: "establish Connection", message: "busy" })),
            }),
          ),
          Layer.provideMerge(
            Layer.effect(
              CredentialStore,
              Effect.map(ConfiguredCredentials, (configured) => ({
                ...unusedCredentialStore,
                resolveSource: () =>
                  Effect.succeed({
                    source: "github-cli" as const,
                    token: Redacted.make("secret"),
                    identity: null,
                  }),
                configureConnection: (connectionId) =>
                  Ref.update(configured, (current) => [...current, connectionId]),
              })),
            ).pipe(Layer.provideMerge(ConfiguredCredentials.layer)),
          ),
        ),
      ),
    ),
  );
});
