import { localOwnerId, WorkspaceId } from "@cogwork/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, layer } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { bootControlStoreLayer, ControlStore, controlStoreClientLayer } from "./control-store";
import { PluginManager, pluginManagerLayer } from "./plugin";

const write = Effect.fn("test.writePluginFile")(function* (file: string, content: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  yield* fs.writeFileString(file, content);
});

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
const configLayer = ConfigProvider.layer(ConfigProvider.fromEnv({ env: { LINEAR_API_KEY: "test-key" } }));

const manifestDocument = (version: string) =>
  JSON.stringify({
    pluginId: "linear",
    version,
    provenance: `fixture-${version}`,
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

function fixture() {
  return Effect.gen(function* () {
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
    const storeLayer = bootControlStoreLayer(storePath).pipe(
      Layer.provideMerge(controlStoreClientLayer(storePath)),
    );
    const managerLayer = Layer.merge(
      pluginManagerLayer({ catalogPath, provisionRoot }).pipe(Layer.provideMerge(storeLayer)),
      configLayer,
    );
    return { root, catalogPath, bundlePath, storePath, provisionRoot, storeLayer, managerLayer };
  });
}

layer(NodeServices.layer)((it) => {
  it.effect("installs atomically, enables its MCP server, and retries idempotently", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const test = yield* fixture();
      yield* Effect.gen(function* () {
        const plugins = yield* PluginManager;
        const first = yield* plugins.install("linear", localOwnerId);
        const second = yield* plugins.install("linear", localOwnerId);
        const store = yield* ControlStore;
        if (store.health === "unavailable") return assert.fail(store.message);
        const picture = yield* store.picture;

        assert.strictEqual(first.overview.plugins[0]?.record?.resolvedIdentity, "linear@1.0.0");
        assert.deepStrictEqual(second.overview, first.overview);
        assert.strictEqual(picture.pluginInstalls.length, 1);
        assert.deepStrictEqual(picture.contributionSettings, [
          {
            contribution: { id: "plugin:linear/mcp/linear", kind: "mcp-server" },
            scope: { _tag: "SettingsProfile" },
            enabled: true,
          },
        ]);
        assert.isTrue(yield* fs.exists(path.join(test.provisionRoot, "linear@1.0.0")));
        assert.deepStrictEqual((yield* fs.readDirectory(test.provisionRoot)).sort(), ["linear@1.0.0"]);
      }).pipe(Effect.provide(test.managerLayer));
    }),
  );

  it.effect("keeps a Plugin MCP server active after its setting is cleared", () =>
    Effect.gen(function* () {
      const test = yield* fixture();
      yield* Effect.gen(function* () {
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
      }).pipe(Effect.provide(test.managerLayer));
    }),
  );

  it.effect("adopts a catalog version when a new Plugin manager loads", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const test = yield* fixture();
      yield* Effect.gen(function* () {
        yield* (yield* PluginManager).install("linear", localOwnerId);
      }).pipe(Effect.provide(test.managerLayer));
      yield* write(path.join(test.bundlePath, "plugin.json"), manifestDocument("2.0.0"));
      const storeLayer = bootControlStoreLayer(test.storePath).pipe(
        Layer.provideMerge(controlStoreClientLayer(test.storePath)),
      );
      const reloaded = Layer.merge(
        pluginManagerLayer({
          catalogPath: test.catalogPath,
          provisionRoot: test.provisionRoot,
        }).pipe(Layer.provideMerge(storeLayer)),
        configLayer,
      );
      const overview = yield* Effect.gen(function* () {
        return yield* (yield* PluginManager).overview;
      }).pipe(Effect.provide(reloaded));

      assert.strictEqual(overview.plugins[0]?.record?.resolvedIdentity, "linear@2.0.0");
      assert.isFalse(yield* fs.exists(path.join(test.provisionRoot, "linear@1.0.0")));
      assert.isTrue(yield* fs.exists(path.join(test.provisionRoot, "linear@2.0.0")));
    }),
  );

  it.effect("keeps valid files active when another pointed file becomes malformed", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const test = yield* fixture();
      yield* Effect.gen(function* () {
        const plugins = yield* PluginManager;
        yield* plugins.install("linear", localOwnerId);
        yield* write(path.join(test.bundlePath, "plugin.json"), manifestDocument("2.0.0"));
        yield* write(path.join(test.bundlePath, "mcp", "linear.json"), "not json");

        const result = yield* plugins.install("linear", localOwnerId);
        const item = result.overview.plugins[0];
        const store = yield* ControlStore;
        if (store.health === "unavailable") return assert.fail(store.message);
        const picture = yield* store.picture;

        assert.strictEqual(item?.contributions.find((row) => row.kind === "rules")?.load._tag, "Loaded");
        assert.strictEqual(item?.contributions.find((row) => row.kind === "mcp-server")?.load._tag, "Failed");
        assert.strictEqual(picture.contributionSettings[0]?.contribution.id, "plugin:linear/mcp/linear");
      }).pipe(Effect.provide(test.managerLayer));
    }),
  );

  it.effect("names a file whose MCP config contains a bare environment interpolation", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const test = yield* fixture();
      yield* write(
        path.join(test.bundlePath, "mcp", "linear.json"),
        '{"endpoint":"https://mcp.linear.app/mcp","authorization":"Bearer $' + '{LINEAR_API_KEY}"}',
      );
      const overview = yield* Effect.gen(function* () {
        const plugins = yield* PluginManager;
        return (yield* plugins.install("linear", localOwnerId)).overview;
      }).pipe(Effect.provide(test.managerLayer));
      const failed = overview.plugins[0]?.contributions[0];

      assert.strictEqual(failed?.load._tag, "Failed");
      assert.include(failed?.file ?? "", "linear.json");
      assert.include(failed?.load._tag === "Failed" ? failed.load.reason : "", "bare environment");
    }),
  );

  it.effect("installs nothing when the manifest is unreadable", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const test = yield* fixture();
      yield* write(path.join(test.bundlePath, "plugin.json"), "not json");
      yield* Effect.gen(function* () {
        const plugins = yield* PluginManager;
        const failure = yield* Effect.flip(plugins.install("linear", localOwnerId));
        const store = yield* ControlStore;
        if (store.health === "unavailable") return assert.fail(store.message);

        assert.include(failure.file ?? "", "plugin.json");
        assert.deepStrictEqual((yield* store.picture).pluginInstalls, []);
        assert.isFalse(
          yield* (yield* FileSystem.FileSystem).exists(path.join(test.provisionRoot, "linear@1.0.0")),
        );
      }).pipe(Effect.provide(test.managerLayer));
    }),
  );

  it.effect("rejects a Plugin identity that escapes the provision root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const test = yield* fixture();
      yield* write(
        test.catalogPath,
        catalogDocument.replace('"pluginId":"linear"', '"pluginId":"../../escape"'),
      );
      yield* write(
        path.join(test.bundlePath, "plugin.json"),
        manifestDocument("1.0.0").replace('"pluginId":"linear"', '"pluginId":"../../escape"'),
      );
      const error = yield* Effect.gen(function* () {
        return yield* Effect.flip((yield* PluginManager).install("../../escape", localOwnerId));
      }).pipe(Effect.provide(test.managerLayer));

      assert.include(error.message, "identity escapes provision root");
      assert.isFalse(yield* fs.exists(path.join(test.root, "escape@1.0.0")));
    }),
  );

  it.effect("uninstalls owned settings and leaves required Connections to their owner", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const test = yield* fixture();
      yield* Effect.gen(function* () {
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
          ["rules"],
        );
        assert.deepStrictEqual(picture.pluginInstalls, []);
        assert.deepStrictEqual(picture.contributionSettings, []);
        assert.deepStrictEqual(result.notices, ["The linear Connection remains established."]);
        assert.isFalse(
          yield* (yield* FileSystem.FileSystem).exists(path.join(test.provisionRoot, "linear@1.0.0")),
        );
        const reclaimed = yield* (yield* FileSystem.FileSystem).readDirectory(
          path.join(test.provisionRoot, ".reclaim"),
        );
        assert.isTrue(reclaimed[0]?.startsWith("linear@1.0.0--"));
      }).pipe(Effect.provide(test.managerLayer));
    }),
  );

  it.effect("keeps membership retryable when file reclamation fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const test = yield* fixture();
      yield* Effect.gen(function* () {
        const plugins = yield* PluginManager;
        yield* plugins.install("linear", localOwnerId);
        yield* fs.writeFileString(path.join(test.provisionRoot, ".reclaim"), "blocked");

        yield* Effect.flip(plugins.uninstall("linear"));
        const store = yield* ControlStore;
        if (store.health === "unavailable") return assert.fail(store.message);
        assert.strictEqual((yield* store.picture).pluginInstalls.length, 1);
        assert.isTrue(yield* fs.exists(path.join(test.provisionRoot, "linear@1.0.0")));

        yield* fs.remove(path.join(test.provisionRoot, ".reclaim"));
        yield* plugins.uninstall("linear");
        assert.deepStrictEqual((yield* store.picture).pluginInstalls, []);
      }).pipe(Effect.provide(test.managerLayer));
    }),
  );

  it.effect("restores provisioned files when uninstall is interrupted before membership removal", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const test = yield* fixture();
      const removalStarted = yield* Deferred.make<void>();
      const managerLayer = Layer.merge(
        pluginManagerLayer({
          catalogPath: test.catalogPath,
          provisionRoot: test.provisionRoot,
        }).pipe(
          Layer.provideMerge(
            Layer.effect(
              ControlStore,
              Effect.gen(function* () {
                const store = yield* ControlStore;
                if (store.health === "unavailable") return store;
                return {
                  ...store,
                  uninstallPlugin: () =>
                    Deferred.succeed(removalStarted, undefined).pipe(Effect.andThen(Effect.never)),
                };
              }),
            ).pipe(Layer.provide(test.storeLayer)),
          ),
        ),
        configLayer,
      );

      yield* Effect.gen(function* () {
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
        assert.isTrue(yield* fs.exists(path.join(test.provisionRoot, "linear@1.0.0")));
      }).pipe(Effect.provide(managerLayer));
    }),
  );
});
