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
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import { ConnectionStore, connectionOverview, layer } from "./connection";
import { acceptingLayer as acceptingVerifierLayer, ConnectionVerifier } from "./connection-verify";
import { ControlStore, type ControlStoreService } from "./control-store";
import { CredentialError, CredentialStore, type CredentialStoreService } from "./credential-store";

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

class CredentialConfigurationGate extends Context.Service<
  CredentialConfigurationGate,
  {
    readonly started: Deferred.Deferred<void>;
    readonly release: Deferred.Deferred<void>;
  }
>()("@cogwork/engine/connection.test/CredentialConfigurationGate") {
  static readonly layer = Layer.effect(
    CredentialConfigurationGate,
    Effect.all({ started: Deferred.make<void>(), release: Deferred.make<void>() }),
  );
}

class FailingConnectionWrite extends Context.Service<
  FailingConnectionWrite,
  Ref.Ref<{ readonly attempts: number; readonly connection: Connection }>
>()("@cogwork/engine/connection.test/FailingConnectionWrite") {
  static readonly layer = Layer.effect(
    FailingConnectionWrite,
    Ref.make({
      attempts: 0,
      connection: Connection.make({
        id: connectionIdOf("github", "octocat"),
        system: "github",
        account: "octocat",
        status: "revoked",
      }),
    }),
  );
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
  updateOperationSettings: () => Effect.succeed(defaultControlStore),
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

const unavailableVerifier = Layer.succeed(ConnectionVerifier, {
  verify: () => Effect.fail(new IssueTrackerError({ reason: "unavailable", message: "Granola unavailable" })),
});

describe("Connection verification", () => {
  it.effect("reports a failed Slack refresh as not ready", () => {
    const slack = Connection.make({
      id: connectionIdOf("slack", "T-STUB"),
      system: "slack",
      account: "T-STUB",
      status: "established",
    });
    return Effect.gen(function* () {
      const connections = yield* ConnectionStore;
      const readiness = yield* connections.readiness(slack.id);

      assert.deepStrictEqual(readiness, {
        _tag: "NotReady",
        reason: "Slack token refresh failed: refresh token expired",
      });
      assert.strictEqual((yield* connections.find(slack.id))?.id, slack.id);
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(acceptingVerifierLayer),
          Layer.provide(
            Layer.succeed(CredentialStore, {
              ...unusedCredentialStore,
              bearerToken: () =>
                Effect.fail(
                  new CredentialError({
                    account: slack.id,
                    message: "Slack token refresh failed: refresh token expired",
                    retryable: false,
                  }),
                ),
            }),
          ),
          Layer.provide(
            Layer.succeed(ControlStore, {
              ...controlStoreService,
              picture: Effect.succeed({ ...defaultControlStore, connections: [slack] }),
            }),
          ),
        ),
      ),
    );
  });

  it.effect("keeps GitHub ready when its remote verifier is unavailable", () =>
    Effect.gen(function* () {
      const connections = yield* ConnectionStore;
      const readiness = yield* connections.readiness(github.id);

      assert.strictEqual(readiness._tag, "Ready");
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(rejectingVerifier),
          Layer.provide(
            Layer.succeed(CredentialStore, {
              ...unusedCredentialStore,
              bearerToken: () =>
                Effect.succeed({
                  source: "stored-key" as const,
                  token: Redacted.make("valid"),
                  identity: null,
                }),
            }),
          ),
          Layer.provide(
            Layer.succeed(ControlStore, {
              ...controlStoreService,
              picture: Effect.succeed({ ...defaultControlStore, connections: [github] }),
            }),
          ),
        ),
      ),
    ),
  );

  it.effect("keeps Granola ready when its remote verifier is unavailable", () => {
    const granola = Connection.make({
      id: connectionIdOf("granola", "person@example.com"),
      system: "granola",
      account: "person@example.com",
      status: "established",
    });
    return Effect.gen(function* () {
      const connections = yield* ConnectionStore;
      const readiness = yield* connections.readiness(granola.id);

      assert.strictEqual(readiness._tag, "Ready");
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(unavailableVerifier),
          Layer.provide(
            Layer.succeed(CredentialStore, {
              ...unusedCredentialStore,
              bearerToken: () =>
                Effect.succeed({
                  source: "stored-oauth" as const,
                  token: Redacted.make("valid"),
                  identity: { organization: granola.account, actorUserId: granola.account },
                }),
            }),
          ),
          Layer.provide(
            Layer.succeed(ControlStore, {
              ...controlStoreService,
              picture: Effect.succeed({ ...defaultControlStore, connections: [granola] }),
            }),
          ),
        ),
      ),
    );
  });

  it.effect("establishes Granola while its verifier is unavailable", () =>
    Effect.gen(function* () {
      const connections = yield* ConnectionStore;
      const result = yield* Effect.result(
        connections.establish({
          system: "granola",
          account: "person@example.com",
          source: { _tag: "Stored" },
        }),
      );

      assert.isTrue(Result.isSuccess(result));
      if (Result.isFailure(result)) return;
      const connection = result.success;
      assert.strictEqual(connection.id, connectionIdOf("granola", "person@example.com"));
      assert.deepStrictEqual(yield* Ref.get(yield* ConfiguredCredentials), [connection.id]);
      assert.deepStrictEqual(yield* Ref.get(yield* EstablishedConnections), [connection.id]);
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(unavailableVerifier),
          Layer.provideMerge(
            Layer.effect(
              CredentialStore,
              Effect.map(ConfiguredCredentials, (configured) => ({
                ...unusedCredentialStore,
                resolveSource: () =>
                  Effect.succeed({
                    source: "stored-oauth" as const,
                    token: Redacted.make("valid"),
                    identity: { organization: "person@example.com", actorUserId: "person@example.com" },
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

  it.effect("keeps a revoked Granola grant as a not-ready Connection", () => {
    const granola = Connection.make({
      id: connectionIdOf("granola", "person@example.com"),
      system: "granola",
      account: "person@example.com",
      status: "established",
    });
    return Effect.gen(function* () {
      const connections = yield* ConnectionStore;
      const readiness = yield* connections.readiness(granola.id);

      assert.strictEqual(readiness._tag, "NotReady");
      if (readiness._tag === "NotReady") assert.include(readiness.reason, "401");
      assert.strictEqual((yield* connections.find(granola.id))?.id, granola.id);
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(rejectingVerifier),
          Layer.provide(
            Layer.succeed(CredentialStore, {
              ...unusedCredentialStore,
              bearerToken: () =>
                Effect.succeed({
                  source: "stored-oauth" as const,
                  token: Redacted.make("revoked"),
                  identity: { organization: granola.account, actorUserId: granola.account },
                }),
            }),
          ),
          Layer.provide(
            Layer.succeed(ControlStore, {
              ...controlStoreService,
              picture: Effect.succeed({ ...defaultControlStore, connections: [granola] }),
            }),
          ),
        ),
      ),
    );
  });

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

  it.effect("retains the stored GitHub account casing on re-connect", () =>
    Effect.gen(function* () {
      const connections = yield* ConnectionStore;
      const connection = yield* connections.establish(
        { system: "github", source: { _tag: "GitHubCli" } },
        "OctoCat",
      );

      assert.strictEqual(connection.id, connectionIdOf("github", "OctoCat"));
      assert.strictEqual(connection.account, "OctoCat");
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(Layer.succeed(ConnectionVerifier, { verify: () => Effect.succeed("octocat") })),
          Layer.provide(controlStoreLayer),
          Layer.provide(
            Layer.succeed(CredentialStore, {
              ...unusedCredentialStore,
              resolveSource: () =>
                Effect.succeed({
                  source: "github-cli" as const,
                  token: Redacted.make("secret"),
                  identity: null,
                }),
              configureConnection: () => Effect.void,
            }),
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

  it.effect("keeps a revoked Connection revoked when the Control store write fails", () =>
    Effect.gen(function* () {
      const connections = yield* ConnectionStore;
      const id = connectionIdOf("github", "octocat");
      const failure = yield* Effect.flip(
        connections.establish({ system: "github", source: { _tag: "GitHubCli" } }, "octocat"),
      );

      assert.strictEqual(failure._tag, "ConnectionFailure");
      assert.strictEqual((yield* connections.find(id))?.status, "revoked");
      assert.deepStrictEqual(yield* Ref.get(yield* ConfiguredCredentials), []);
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(Layer.succeed(ConnectionVerifier, { verify: () => Effect.succeed("octocat") })),
          Layer.provide(
            Layer.effect(
              ControlStore,
              Effect.map(FailingConnectionWrite, (state) => ({
                ...controlStoreService,
                picture: Ref.get(state).pipe(
                  Effect.map(({ connection }) => ({ ...defaultControlStore, connections: [connection] })),
                ),
                establishConnection: (connection) =>
                  Ref.updateAndGet(state, (current) => ({
                    ...current,
                    attempts: current.attempts + 1,
                  })).pipe(
                    Effect.flatMap((current) => {
                      if (current.attempts === 1) {
                        return Effect.fail(
                          ControlStoreFailure.make({
                            operation: "establish Connection",
                            message: "busy",
                            retryable: true,
                          }),
                        );
                      }
                      const established = Connection.make({ ...connection, status: "established" });
                      return Ref.set(state, { ...current, connection: established }).pipe(
                        Effect.map(() => ({ ...defaultControlStore, connections: [established] })),
                      );
                    }),
                  ),
              })),
            ).pipe(Layer.provide(FailingConnectionWrite.layer)),
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

  it.effect("finishes credential configuration when interrupted after the Control write", () =>
    Effect.gen(function* () {
      const connections = yield* ConnectionStore;
      const gate = yield* CredentialConfigurationGate;
      const id = connectionIdOf("github", "octocat");
      const establishing = yield* connections
        .establish({ system: "github", source: { _tag: "GitHubCli" } })
        .pipe(Effect.forkChild({ startImmediately: true }));

      yield* Deferred.await(gate.started);
      const interrupting = yield* Fiber.interrupt(establishing).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.succeed(gate.release, undefined);
      yield* Fiber.join(interrupting);

      assert.deepStrictEqual(yield* Ref.get(yield* EstablishedConnections), [id]);
      assert.deepStrictEqual(yield* Ref.get(yield* ConfiguredCredentials), [id]);
      assert.deepStrictEqual(yield* Ref.get(yield* RemovedConnections), []);
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(Layer.succeed(ConnectionVerifier, { verify: () => Effect.succeed("octocat") })),
          Layer.provideMerge(
            Layer.effect(
              CredentialStore,
              Effect.gen(function* () {
                const configured = yield* ConfiguredCredentials;
                const gate = yield* CredentialConfigurationGate;
                return {
                  ...unusedCredentialStore,
                  resolveSource: () =>
                    Effect.succeed({
                      source: "github-cli" as const,
                      token: Redacted.make("secret"),
                      identity: null,
                    }),
                  configureConnection: (connectionId) =>
                    Deferred.succeed(gate.started, undefined).pipe(
                      Effect.andThen(Deferred.await(gate.release)),
                      Effect.andThen(Ref.update(configured, (current) => [...current, connectionId])),
                    ),
                } satisfies CredentialStoreService;
              }),
            ).pipe(
              Layer.provideMerge(ConfiguredCredentials.layer),
              Layer.provideMerge(CredentialConfigurationGate.layer),
            ),
          ),
          Layer.provideMerge(
            Layer.effect(
              ControlStore,
              Effect.gen(function* () {
                const established = yield* EstablishedConnections;
                const removed = yield* RemovedConnections;
                return {
                  ...controlStoreService,
                  establishConnection: (connection) =>
                    Ref.update(established, (current) => [...current, connection.id]).pipe(
                      Effect.map(() => defaultControlStore),
                    ),
                  removeConnection: (connectionId) =>
                    Ref.update(removed, (current) => [...current, connectionId]).pipe(
                      Effect.map(() => defaultControlStore),
                    ),
                } satisfies ControlStoreService;
              }),
            ).pipe(
              Layer.provideMerge(EstablishedConnections.layer),
              Layer.provideMerge(RemovedConnections.layer),
            ),
          ),
        ),
      ),
    ),
  );
});
