import { Connection, ContentRevision, DeclaredVersion, localOwnerId, WorkspaceId } from "@cogwork/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, layer } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ConnectionStore } from "./connection";
import { bootControlStoreLayer, ControlStore } from "./control-store";
import { PluginManager, pluginManagerLayer } from "./plugin";

const write = Effect.fn("test.writePluginFile")(function* (file: string, content: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  yield* fs.writeFileString(file, content);
});

const interruptionGate = Latch.makeUnsafe();

const catalogDocument = JSON.stringify({
  plugins: [
    {
      pluginId: "linear",
      name: "Linear",
      summary: "Linear tools",
      bundle: "bundles/linear",
    },
  ],
});

const workspaceId = Schema.decodeSync(WorkspaceId)("workspace-1");
const linearConnection = Schema.decodeSync(Connection)({
  id: "linear/acme",
  system: "linear",
  account: "acme",
  status: "established",
});
const connectionStoreLayer = Layer.succeed(ConnectionStore, {
  overview: Effect.succeed({ connections: [] }),
  find: (connectionId) => Effect.succeed(connectionId === linearConnection.id ? linearConnection : null),
  findSystem: (system) => Effect.succeed(system === "linear" ? linearConnection : null),
  bearer: () => Effect.die("unexpected credential read"),
  readiness: () => Effect.succeed({ _tag: "Ready" }),
  requireReady: () => Effect.void,
  requireSystemReady: () => Effect.void,
  establish: () => Effect.succeed(linearConnection),
  revoke: () => Effect.void,
  remove: () => Effect.void,
});
const unavailableConnectionStoreLayer = Layer.succeed(ConnectionStore, {
  overview: Effect.succeed({ connections: [] }),
  find: () => Effect.succeed(null),
  findSystem: () => Effect.succeed(null),
  bearer: () => Effect.die("unexpected credential read"),
  readiness: () => Effect.succeed({ _tag: "NotReady", reason: "Not connected" }),
  requireReady: () => Effect.die("unexpected Connection requirement"),
  requireSystemReady: () => Effect.die("unexpected Connection requirement"),
  establish: () => Effect.die("unexpected Connection establishment"),
  revoke: () => Effect.void,
  remove: () => Effect.void,
});
const configLayer = ConfigProvider.layer(ConfigProvider.fromEnv({ env: { LINEAR_API_KEY: "test-key" } }));

const manifestDocument = (version: string | null, provenance = `fixture-${version}`) =>
  JSON.stringify({
    pluginId: "linear",
    ...(version === null ? {} : { version }),
    provenance,
    authRecipe: null,
    requiredConnections: ["linear"],
    contributions: [
      {
        kind: "mcp-server",
        localName: "linear",
        summary: "Linear MCP server",
        file: "mcp/linear.json",
      },
      {
        kind: "rules",
        localName: "linear-style",
        summary: "Linear conventions",
        file: "rules/linear-style.md",
      },
    ],
  });

interface PluginFixtureState {
  readonly root: string;
  readonly catalogPath: string;
  readonly bundlePath: string;
  readonly storePath: string;
  readonly provisionRoot: string;
}

const storeLayerAt = (storePath: string) =>
  Layer.effect(ControlStore, ControlStore).pipe(Layer.provide(bootControlStoreLayer(storePath)));

class PluginFixture extends Context.Service<PluginFixture, PluginFixtureState>()(
  "@cogwork/engine/plugin.test/PluginFixture",
) {
  static readonly layer = Layer.effect(
    PluginFixture,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-plugin-" });
      const catalogPath = path.join(root, "catalog.json");
      const bundlePath = path.join(root, "bundles", "linear");
      const storePath = path.join(root, "control.db");
      const provisionRoot = path.join(root, "provisioned");
      yield* write(catalogPath, catalogDocument);
      yield* write(path.join(bundlePath, "plugin.json"), manifestDocument("1.0.0"));
      yield* write(
        path.join(bundlePath, "mcp", "linear.json"),
        '{"endpoint":"https://mcp.linear.app/mcp","secret":{"env":"LINEAR_API_KEY"}}',
      );
      yield* write(path.join(bundlePath, "rules", "linear-style.md"), "Prefer short issue titles.");
      return { root, catalogPath, bundlePath, storePath, provisionRoot };
    }),
  );
}

class RemovalStarted extends Context.Service<RemovalStarted, Deferred.Deferred<void>>()(
  "@cogwork/engine/plugin.test/RemovalStarted",
) {
  static readonly layer = Layer.effect(RemovalStarted, Deferred.make<void>());
}

const managerLayerFor = <E, R>(
  fixture: PluginFixtureState,
  connections: typeof connectionStoreLayer,
  storeLayer: Layer.Layer<Layer.Success<ReturnType<typeof storeLayerAt>>, E, R>,
) =>
  Layer.merge(
    pluginManagerLayer({
      catalogPath: fixture.catalogPath,
      provisionRoot: fixture.provisionRoot,
    }).pipe(Layer.provide(connections), Layer.provideMerge(storeLayer)),
    configLayer,
  );

const fixtureLayer = (connections: typeof connectionStoreLayer = connectionStoreLayer) =>
  Layer.unwrap(
    Effect.map(PluginFixture, (fixture) =>
      managerLayerFor(fixture, connections, storeLayerAt(fixture.storePath)),
    ),
  ).pipe(Layer.provideMerge(PluginFixture.layer));

const overviewFromNewManager = (fixture: PluginFixtureState) =>
  Effect.flatMap(PluginManager, (plugins) => plugins.overview).pipe(
    Effect.provide(managerLayerFor(fixture, connectionStoreLayer, storeLayerAt(fixture.storePath))),
  );

const interruptedStoreLayer = Layer.unwrap(
  Effect.gen(function* () {
    const fixture = yield* PluginFixture;
    const removalStarted = yield* RemovalStarted;
    return Layer.effect(
      ControlStore,
      Effect.map(ControlStore, (store) => {
        if (store.health === "unavailable") return store;
        return {
          ...store,
          uninstallPlugin: () =>
            Deferred.succeed(removalStarted, undefined).pipe(
              Effect.andThen(
                interruptionGate.await.pipe(Effect.flatMap(() => Effect.die("interruption gate opened"))),
              ),
            ),
        };
      }),
    ).pipe(Layer.provide(storeLayerAt(fixture.storePath)));
  }),
);

const interruptedFixtureLayer = () =>
  Layer.unwrap(
    Effect.map(PluginFixture, (fixture) =>
      managerLayerFor(fixture, connectionStoreLayer, interruptedStoreLayer),
    ),
  ).pipe(Layer.provideMerge(Layer.merge(PluginFixture.layer, RemovalStarted.layer)));
layer(NodeServices.layer)((it) => {
  it.effect("installs atomically, enables its MCP server, and retries idempotently", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const fixture = yield* PluginFixture;
      const plugins = yield* PluginManager;
      const first = yield* plugins.install("linear", localOwnerId);
      const second = yield* plugins.install("linear", localOwnerId);
      const store = yield* ControlStore;
      if (store.health === "unavailable") return assert.fail(store.message);
      const picture = yield* store.picture;

      assert.strictEqual(first.overview.plugins[0]?.record?.resolvedIdentity, "linear@1.0.0");
      assert.deepStrictEqual(
        first.overview.plugins[0]?.provenanceStamp,
        DeclaredVersion.make({ source: "plugin:linear", version: "1.0.0" }),
      );
      assert.deepStrictEqual(second.overview, first.overview);
      const load = first.overview.plugins[0]?.contributions.find(
        (contribution) => contribution.kind === "mcp-server",
      )?.load;
      if (load?._tag !== "Loaded") return assert.fail("expected loaded MCP server");
      const mcpServer = load.mcpServer;
      assert.strictEqual(mcpServer?.connectionId, linearConnection.id);
      assert.isTrue(mcpServer?.credentialAvailable);
      assert.strictEqual(picture.pluginInstalls.length, 1);
      assert.deepStrictEqual(picture.contributionSettings, [
        {
          contribution: { id: "plugin:linear/mcp/linear", kind: "mcp-server" },
          scope: { _tag: "SettingsProfile" },
          enabled: true,
        },
      ]);
      assert.isTrue(yield* fs.exists(path.join(fixture.provisionRoot, "linear@1.0.0")));
      assert.deepStrictEqual((yield* fs.readDirectory(fixture.provisionRoot)).sort(), ["linear@1.0.0"]);
    }).pipe(Effect.provide(fixtureLayer())),
  );

  it.effect("trims provenance values and treats a blank declared version as absent", () =>
    Effect.gen(function* () {
      const { bundlePath } = yield* PluginFixture;
      const path = yield* Path.Path;
      const plugins = yield* PluginManager;
      yield* write(path.join(bundlePath, "plugin.json"), manifestDocument("  1.0.0\n", "fixture-version"));
      const versioned = yield* plugins.install("linear", localOwnerId);
      yield* write(path.join(bundlePath, "plugin.json"), manifestDocument(null, "\tfixture-revision  "));
      const revisioned = yield* plugins.install("linear", localOwnerId);
      yield* write(
        path.join(bundlePath, "plugin.json"),
        manifestDocument("  \n", "  fixture-blank-version\t"),
      );
      const blankVersion = yield* plugins.install("linear", localOwnerId);

      assert.strictEqual(versioned.overview.plugins[0]?.record?.resolvedIdentity, "linear@1.0.0");
      assert.deepStrictEqual(
        versioned.overview.plugins[0]?.provenanceStamp,
        DeclaredVersion.make({ source: "plugin:linear", version: "1.0.0" }),
      );
      assert.strictEqual(revisioned.overview.plugins[0]?.record?.resolvedIdentity, "linear@fixture-revision");
      assert.deepStrictEqual(
        revisioned.overview.plugins[0]?.provenanceStamp,
        ContentRevision.make({ source: "plugin:linear", revision: "fixture-revision" }),
      );
      assert.strictEqual(
        blankVersion.overview.plugins[0]?.record?.resolvedIdentity,
        "linear@fixture-blank-version",
      );
      assert.deepStrictEqual(
        blankVersion.overview.plugins[0]?.provenanceStamp,
        ContentRevision.make({ source: "plugin:linear", revision: "fixture-blank-version" }),
      );
    }).pipe(Effect.provide(fixtureLayer())),
  );

  it.effect("keeps a Plugin MCP server active after its setting is cleared", () =>
    Effect.gen(function* () {
      const plugins = yield* PluginManager;
      yield* plugins.install("linear", localOwnerId);
      const store = yield* ControlStore;
      if (store.health === "unavailable") return assert.fail(store.message);
      yield* store.updateContributionSetting({
        _tag: "Clear",
        cell: {
          contribution: { id: "plugin:linear/mcp/linear", kind: "mcp-server" },
          scope: { _tag: "SettingsProfile" },
        },
      });

      const contributions = yield* plugins.contributions(workspaceId);

      assert.deepStrictEqual(
        contributions.map((contribution) => contribution.kind),
        ["mcp-server", "rules"],
      );
    }).pipe(Effect.provide(fixtureLayer())),
  );

  it.effect("adopts a catalog version when a new Plugin manager loads", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* PluginFixture;
      yield* (yield* PluginManager).install("linear", localOwnerId);
      yield* write(path.join(fixture.bundlePath, "plugin.json"), manifestDocument("2.0.0"));
      const overview = yield* overviewFromNewManager(fixture);

      assert.strictEqual(overview.plugins[0]?.record?.resolvedIdentity, "linear@2.0.0");
      assert.isFalse(yield* fs.exists(path.join(fixture.provisionRoot, "linear@1.0.0")));
      assert.isTrue(yield* fs.exists(path.join(fixture.provisionRoot, "linear@2.0.0")));
    }).pipe(Effect.provide(fixtureLayer())),
  );

  it.effect("keeps valid files active when another pointed file becomes malformed", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fixture = yield* PluginFixture;
      const plugins = yield* PluginManager;
      yield* plugins.install("linear", localOwnerId);
      yield* write(path.join(fixture.bundlePath, "plugin.json"), manifestDocument("2.0.0"));
      yield* write(path.join(fixture.bundlePath, "mcp", "linear.json"), "not json");

      const result = yield* plugins.install("linear", localOwnerId);
      const item = result.overview.plugins[0];
      const store = yield* ControlStore;
      if (store.health === "unavailable") return assert.fail(store.message);
      const picture = yield* store.picture;

      assert.strictEqual(item?.contributions.find((row) => row.kind === "rules")?.load._tag, "Loaded");
      assert.strictEqual(item?.contributions.find((row) => row.kind === "mcp-server")?.load._tag, "Failed");
      assert.strictEqual(picture.contributionSettings[0]?.contribution.id, "plugin:linear/mcp/linear");
    }).pipe(Effect.provide(fixtureLayer())),
  );

  it.effect("names a file whose MCP config contains a bare environment interpolation", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fixture = yield* PluginFixture;
      yield* write(
        path.join(fixture.bundlePath, "mcp", "linear.json"),
        '{"endpoint":"https://mcp.linear.app/mcp","authorization":"Bearer $' + '{LINEAR_API_KEY}"}',
      );
      const overview = (yield* (yield* PluginManager).install("linear", localOwnerId)).overview;
      const failed = overview.plugins[0]?.contributions[0];

      assert.strictEqual(failed?.load._tag, "Failed");
      assert.include(failed?.file ?? "", "linear.json");
      assert.include(failed?.load._tag === "Failed" ? failed.load.reason : "", "bare environment");
    }).pipe(Effect.provide(fixtureLayer())),
  );

  it.effect("installs nothing when the manifest is unreadable", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fixture = yield* PluginFixture;
      yield* write(path.join(fixture.bundlePath, "plugin.json"), "not json");
      const plugins = yield* PluginManager;
      const failure = yield* Effect.flip(plugins.install("linear", localOwnerId));
      const store = yield* ControlStore;
      if (store.health === "unavailable") return assert.fail(store.message);

      assert.include(failure.file ?? "", "plugin.json");
      assert.deepStrictEqual((yield* store.picture).pluginInstalls, []);
      assert.isFalse(
        yield* (yield* FileSystem.FileSystem).exists(path.join(fixture.provisionRoot, "linear@1.0.0")),
      );
    }).pipe(Effect.provide(fixtureLayer())),
  );

  it.effect("rejects a Plugin identity that escapes the provision root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* PluginFixture;
      yield* write(
        fixture.catalogPath,
        catalogDocument.replace('"pluginId":"linear"', '"pluginId":"../../escape"'),
      );
      yield* write(
        path.join(fixture.bundlePath, "plugin.json"),
        manifestDocument("1.0.0").replace('"pluginId":"linear"', '"pluginId":"../../escape"'),
      );
      const error = yield* Effect.flip((yield* PluginManager).install("../../escape", localOwnerId));

      assert.include(error.message, "identity escapes provision root");
      assert.isFalse(yield* fs.exists(path.join(fixture.root, "escape@1.0.0")));
    }).pipe(Effect.provide(fixtureLayer())),
  );

  it.effect("uninstalls owned settings and leaves required Connections to their owner", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fixture = yield* PluginFixture;
      const plugins = yield* PluginManager;
      yield* plugins.install("linear", localOwnerId);
      const store = yield* ControlStore;
      if (store.health === "unavailable") return assert.fail(store.message);
      yield* store.updateContributionSetting({
        _tag: "Set",
        row: {
          contribution: { id: "plugin:linear/mcp/linear", kind: "mcp-server" },
          scope: {
            _tag: "PrivateWorkspaceOverlay",
            workspace: workspaceId,
          },
          enabled: false,
        },
      });
      const contributions = yield* plugins.contributions(workspaceId);

      const result = yield* plugins.uninstall("linear");
      const picture = yield* store.picture;

      assert.deepStrictEqual(
        contributions.map((contribution) => contribution.kind),
        ["mcp-server", "rules"],
      );
      assert.deepStrictEqual(picture.pluginInstalls, []);
      assert.deepStrictEqual(picture.contributionSettings, []);
      assert.deepStrictEqual(result.notices, ["The linear Connection remains established."]);
      assert.isFalse(
        yield* (yield* FileSystem.FileSystem).exists(path.join(fixture.provisionRoot, "linear@1.0.0")),
      );
      const reclaimed = yield* (yield* FileSystem.FileSystem).readDirectory(
        path.join(fixture.provisionRoot, ".reclaim"),
      );
      assert.isTrue(reclaimed[0]?.startsWith("linear@1.0.0--"));
    }).pipe(Effect.provide(fixtureLayer())),
  );

  it.effect("does not require a Connection for an uninstalled Plugin", () =>
    Effect.gen(function* () {
      const contributions = yield* (yield* PluginManager).contributions(workspaceId);

      assert.deepStrictEqual(contributions, []);
    }).pipe(Effect.provide(fixtureLayer(unavailableConnectionStoreLayer))),
  );

  it.effect("keeps disconnected Plugin contributions available for Run Plan admission", () =>
    Effect.gen(function* () {
      const plugins = yield* PluginManager;
      yield* plugins.install("linear", localOwnerId);
      const store = yield* ControlStore;
      if (store.health === "unavailable") return yield* Effect.die(new Error(store.message));
      yield* store.updateContributionSetting({
        _tag: "Set",
        row: {
          contribution: { id: "plugin:linear/mcp/linear", kind: "mcp-server" },
          scope: { _tag: "SettingsProfile" },
          enabled: false,
        },
      });
      const contributions = yield* plugins.contributions(workspaceId);

      assert.deepStrictEqual(
        contributions.map((contribution) => contribution.kind),
        ["mcp-server", "rules"],
      );
    }).pipe(Effect.provide(fixtureLayer(unavailableConnectionStoreLayer))),
  );

  it.effect("keeps membership retryable when file reclamation fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* PluginFixture;
      const plugins = yield* PluginManager;
      yield* plugins.install("linear", localOwnerId);
      yield* fs.writeFileString(path.join(fixture.provisionRoot, ".reclaim"), "blocked");

      yield* Effect.flip(plugins.uninstall("linear"));
      const store = yield* ControlStore;
      if (store.health === "unavailable") return assert.fail(store.message);
      assert.strictEqual((yield* store.picture).pluginInstalls.length, 1);
      assert.isTrue(yield* fs.exists(path.join(fixture.provisionRoot, "linear@1.0.0")));

      yield* fs.remove(path.join(fixture.provisionRoot, ".reclaim"));
      yield* plugins.uninstall("linear");
      assert.deepStrictEqual((yield* store.picture).pluginInstalls, []);
    }).pipe(Effect.provide(fixtureLayer())),
  );

  it.effect("restores provisioned files when uninstall is interrupted before membership removal", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* PluginFixture;
      const removalStarted = yield* RemovalStarted;
      const plugins = yield* PluginManager;
      yield* plugins.install("linear", localOwnerId);
      const uninstalling = yield* plugins
        .uninstall("linear")
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(removalStarted);
      yield* Fiber.interrupt(uninstalling);

      const store = yield* ControlStore;
      if (store.health === "unavailable") return assert.fail(store.message);
      assert.strictEqual((yield* store.picture).pluginInstalls.length, 1);
      assert.isTrue(yield* fs.exists(path.join(fixture.provisionRoot, "linear@1.0.0")));
    }).pipe(Effect.provide(interruptedFixtureLayer())),
  );
});
