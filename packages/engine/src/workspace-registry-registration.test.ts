import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, layer } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { controlStoreClientLayer } from "./control-store";
import { layer as registryLayer } from "./registry";
import { findWorkspace } from "./registry-lookup";
import { WorkspaceManagement } from "./registry-management";
import { WorkspaceRegistry } from "./registry-service";
import {
  githubRegistration,
  makeCheckout,
  makeProbedCheckout,
  readOnlyRegistryLayerAt,
  registration,
  registryLayerAt,
  testGitLayer,
} from "./workspace-registry-fixtures";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const signalRead = (started: Deferred.Deferred<void>, release: Deferred.Deferred<void>) =>
  Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)));

const orderedRead = (
  count: number,
  registerRead: Deferred.Deferred<void>,
  releaseRegister: Deferred.Deferred<void>,
  refreshRead: Deferred.Deferred<void>,
  releaseRefresh: Deferred.Deferred<void>,
) => {
  if (count === 0) return signalRead(registerRead, releaseRegister);
  return signalRead(refreshRead, releaseRefresh);
};

layer(Layer.merge(NodeServices.layer, NodeCrypto.layerSecureRandom))((it) => {
  it.effect("refuses registration when the Control store is unavailable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-workspace-registry-health-" });
      const storePath = path.join(root, "control.db");
      const checkoutPath = yield* makeCheckout(root, "unavailable");
      yield* Layer.build(registryLayerAt(storePath));
      const registryContext = yield* Layer.build(
        registryLayer(storePath, `${storePath}.agents`).pipe(
          Layer.provide(testGitLayer),
          Layer.provide(controlStoreClientLayer(storePath)),
        ),
      );
      const management = Context.get(registryContext, WorkspaceManagement);

      const failure = yield* management
        .register(githubRegistration("unavailable", checkoutPath))
        .pipe(Effect.flip);

      assert.include(failure.message, "did not boot");
    }),
  );

  it.effect("refuses a checkout already bound to a workspace", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-workspace-registry-duplicate-" });
      const storePath = path.join(root, "control.db");
      const checkoutPath = yield* makeCheckout(root, "duplicate");
      const registryContext = yield* Layer.build(registryLayerAt(storePath));
      const management = Context.get(registryContext, WorkspaceManagement);
      const liveRegistry = Context.get(registryContext, WorkspaceRegistry);
      const first = yield* management.register(githubRegistration("first", checkoutPath));
      if (first._tag === "Failed") return assert.fail("expected registration to succeed");
      const duplicate = yield* management
        .register(githubRegistration("duplicate", `${checkoutPath}/./`))
        .pipe(Effect.flip);

      assert.include(duplicate.message, `already registered as ${first.workspace.config.id}`);
      assert.strictEqual((yield* liveRegistry.state).workspaces.length, 1);
    }),
  );

  it.effect("still loads a stored assignee allowlist entry that is not a tracker identity", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-workspace-registry-allowlist-" });
      const storePath = path.join(root, "control.db");
      const checkoutPath = yield* makeCheckout(root, "allowlist");
      const context = yield* Layer.build(registryLayerAt(storePath));
      const change = yield* Context.get(context, WorkspaceManagement).register(
        registration({
          displayName: "allowlist",
          checkoutPath,
          issueTracker: { type: "linear", teams: ["ENG"] },
          linearHistory: false,
        }),
      );
      if (change._tag === "Failed") return assert.fail("expected registration to succeed");
      const storedTracker = yield* encodeJson({
        type: "linear",
        teams: ["ENG"],
        assigneeAllowlist: ["taylor.steele"],
      });
      yield* Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql`UPDATE workspaces SET issue_tracker = ${storedTracker}`,
      ).pipe(Effect.provide(controlStoreClientLayer(storePath)));

      const reloadedContext = yield* Layer.build(registryLayerAt(storePath));
      const state = yield* Context.get(reloadedContext, WorkspaceRegistry).state;

      assert.deepStrictEqual(state.failures, []);
      assert.deepStrictEqual(state.workspaces[0]?.record?.issueTracker.assigneeAllowlist, ["taylor.steele"]);
    }),
  );

  it.effect("loads registered workspaces without booting the Control store", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-workspace-registry-read-" });
      const storePath = path.join(root, "control.db");
      const checkoutPath = yield* makeCheckout(root, "read-only");
      const writableContext = yield* Layer.build(registryLayerAt(storePath));
      const management = Context.get(writableContext, WorkspaceManagement);
      const change = yield* management.register(githubRegistration("read-only", checkoutPath));
      if (change._tag === "Failed") return assert.fail("expected registration to succeed");
      yield* Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql`CREATE TABLE read_only_probe (id INTEGER PRIMARY KEY)`,
      ).pipe(Effect.provide(controlStoreClientLayer(storePath)));

      const readOnlyContext = yield* Layer.build(readOnlyRegistryLayerAt(storePath));
      const reloaded = Context.get(readOnlyContext, WorkspaceRegistry);

      assert.isDefined(findWorkspace(yield* reloaded.state, change.workspace.config.id));
    }),
  );

  it.effect("round-trips worktree and MCP settings through the Control store", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-workspace-registry-settings-" });
      const storePath = path.join(root, "control.db");
      const checkoutPath = path.join(root, "settings");
      yield* fs.makeDirectory(checkoutPath, { recursive: true });
      const context = yield* Layer.build(registryLayerAt(storePath));
      const management = Context.get(context, WorkspaceManagement);
      const change = yield* management.register(
        registration({
          displayName: "settings",
          checkoutPath,
          issueTracker: { type: "linear", teams: ["ENG"] },
          worktrees: { setup: ["pnpm install"], linkPaths: [".env"] },
          mcpSkills: [
            {
              name: "linear",
              endpoint: "https://mcp.linear.app/mcp/readonly",
              auth: { type: "credential-store" },
            },
          ],
        }),
      );

      if (change._tag === "Failed") return assert.fail("expected registration to succeed");
      const reloadedContext = yield* Layer.build(registryLayerAt(storePath));
      const [reloaded] = (yield* Context.get(reloadedContext, WorkspaceRegistry).state).workspaces;

      assert.deepStrictEqual(reloaded?.config.worktrees, {
        setup: ["pnpm install"],
        linkPaths: [".env"],
      });
      assert.deepStrictEqual(reloaded?.config.mcpSkills, [
        {
          name: "linear",
          endpoint: "https://mcp.linear.app/mcp/readonly",
          auth: { type: "credential-store" },
        },
      ]);
    }),
  );

  it.effect("keeps a registration made while refresh is loading", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-workspace-registry-stale-" });
      const storePath = path.join(root, "control.db");
      const firstCheckout = yield* makeProbedCheckout(root, "first");
      const secondCheckout = yield* makeProbedCheckout(root, "second");
      const gated = yield* Ref.make(false);
      const gatedReads = yield* Ref.make(0);
      const refreshRead = yield* Deferred.make<void>();
      const releaseRefresh = yield* Deferred.make<void>();
      const gatedFileSystem = FileSystem.FileSystem.of({
        ...fs,
        stat: (target) =>
          Ref.get(gated).pipe(
            Effect.flatMap((enabled) => {
              if (!enabled) return fs.stat(target);
              return Ref.getAndUpdate(gatedReads, (count) => count + 1).pipe(
                Effect.flatMap((count) => {
                  if (count > 0) return fs.stat(target);
                  return Deferred.succeed(refreshRead, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseRefresh)),
                    Effect.andThen(fs.stat(target)),
                  );
                }),
              );
            }),
          ),
      });
      const fileSystemLayer = Layer.succeed(FileSystem.FileSystem, gatedFileSystem);
      const registryContext = yield* Layer.build(
        registryLayerAt(storePath).pipe(Layer.provide(fileSystemLayer)),
      );
      const management = Context.get(registryContext, WorkspaceManagement);
      const liveRegistry = Context.get(registryContext, WorkspaceRegistry);
      yield* management.register(githubRegistration("first", firstCheckout));
      yield* Ref.set(gated, true);
      const refreshing = yield* liveRegistry.refresh.pipe(Effect.forkChild);
      yield* Deferred.await(refreshRead);
      const second = yield* management.register(githubRegistration("second", secondCheckout));
      if (second._tag === "Failed") return assert.fail("expected registration to succeed");
      yield* Deferred.succeed(releaseRefresh, undefined);
      yield* Fiber.join(refreshing);

      assert.isDefined(findWorkspace(yield* liveRegistry.state, second.workspace.config.id));
    }),
  );

  it.effect("keeps one workspace when registration overlaps refresh", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-workspace-registry-race-" });
      const storePath = path.join(root, "control.db");
      const checkoutPath = yield* makeProbedCheckout(root, "race");
      const reads = yield* Ref.make(0);
      const registerRead = yield* Deferred.make<void>();
      const refreshRead = yield* Deferred.make<void>();
      const releaseRegister = yield* Deferred.make<void>();
      const releaseRefresh = yield* Deferred.make<void>();
      const gatedFileSystem = FileSystem.FileSystem.of({
        ...fs,
        stat: (target) =>
          Ref.getAndUpdate(reads, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              orderedRead(count, registerRead, releaseRegister, refreshRead, releaseRefresh),
            ),
            Effect.andThen(fs.stat(target)),
          ),
      });
      const fileSystemLayer = Layer.succeed(FileSystem.FileSystem, gatedFileSystem);
      const registryContext = yield* Layer.build(
        registryLayerAt(storePath).pipe(Layer.provide(fileSystemLayer)),
      );
      const management = Context.get(registryContext, WorkspaceManagement);
      const liveRegistry = Context.get(registryContext, WorkspaceRegistry);
      const registering = yield* management
        .register(githubRegistration("race", checkoutPath))
        .pipe(Effect.forkChild);
      yield* Deferred.await(registerRead);
      const refreshing = yield* liveRegistry.refresh.pipe(Effect.forkChild);
      yield* Deferred.await(refreshRead);
      yield* Deferred.succeed(releaseRefresh, undefined);
      yield* Fiber.join(refreshing);
      yield* Deferred.succeed(releaseRegister, undefined);
      const change = yield* Fiber.join(registering);
      if (change._tag === "Failed") return assert.fail("expected registration to succeed");

      assert.strictEqual(
        (yield* liveRegistry.state).workspaces.filter(
          (workspace) => workspace.config.id === change.workspace.config.id,
        ).length,
        1,
      );
    }),
  );
});
