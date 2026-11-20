import { WorkspaceUpdate } from "@cogwork/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, layer } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { controlStoreClientLayer } from "./control-store";
import {
  findWorkspace,
  findWorkspaceIssueTracker,
  findWorkspaceIssueTrackerBinding,
} from "./registry-lookup";
import { WorkspaceManagement } from "./registry-management";
import { WorkspaceRegistry } from "./registry-service";
import {
  githubRegistration,
  makeCheckout,
  registration,
  registryLayerAt,
} from "./workspace-registry-fixtures";

const workspaceUpdate = Schema.decodeSync(WorkspaceUpdate);

layer(Layer.merge(NodeServices.layer, NodeCrypto.layerSecureRandom))((it) => {
  it.effect("mints distinct identities for duplicate display names and reloads from the Control store", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-workspace-registry-" });
      const storePath = path.join(root, "control.db");
      const firstCheckout = yield* makeCheckout(root, "first");
      const secondCheckout = yield* makeCheckout(root, "second");
      const invalidCheckout = yield* makeCheckout(root, "invalid");

      const registryContext = yield* Layer.build(registryLayerAt(storePath));
      const management = Context.get(registryContext, WorkspaceManagement);
      const liveRegistry = Context.get(registryContext, WorkspaceRegistry);
      const firstChange = yield* management.register(
        registration({
          displayName: "first clone",
          checkoutPath: firstCheckout,
          issueTracker: { type: "github" },
          sourceControl: { type: "github" },
          linearHistory: false,
          worktrees: {
            root: path.join(root, "worktrees"),
            remote: "upstream",
            baseBranch: "trunk",
            setup: ["pnpm install"],
            linkPaths: [".env"],
          },
          concurrency: 2,
        }),
      );
      const secondChange = yield* management.register(
        registration({
          displayName: "first clone",
          checkoutPath: secondCheckout,
          issueTracker: { type: "github" },
          linearHistory: false,
        }),
      );
      const invalidChange = yield* management.register(
        registration({
          displayName: "invalid stored settings",
          checkoutPath: invalidCheckout,
          issueTracker: { type: "github" },
          linearHistory: false,
          concurrency: 3,
        }),
      );
      if (
        firstChange._tag === "Failed" ||
        secondChange._tag === "Failed" ||
        invalidChange._tag === "Failed"
      ) {
        return assert.fail("expected valid workspace registrations");
      }
      const first = firstChange.workspace;
      const second = secondChange.workspace;
      assert.notStrictEqual(first.config.id, second.config.id);
      assert.strictEqual(first.config.displayName, "first clone");
      assert.strictEqual(second.config.displayName, "first clone");
      const state = yield* liveRegistry.state;
      assert.isUndefined(findWorkspace(state, "first clone"));
      assert.strictEqual(findWorkspace(state, first.config.id), first);
      assert.strictEqual(findWorkspace(state, second.config.id), second);
      assert.strictEqual(first.workspaceLimit, 2);
      assert.strictEqual(first.repository, "acme/repo");
      assert.deepStrictEqual(first.config.worktrees, {
        root: path.join(root, "worktrees"),
        remote: "upstream",
        baseBranch: "trunk",
        setup: ["pnpm install"],
        linkPaths: [".env"],
      });
      const invalidId = invalidChange.workspace.config.id;
      yield* Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql`UPDATE workspaces SET mcp_skills = '{ not json' WHERE id = ${invalidId}`,
      ).pipe(Effect.provide(controlStoreClientLayer(storePath)));
      yield* liveRegistry.refresh;
      const refreshedState = yield* liveRegistry.state;
      const [failure] = refreshedState.failures;
      assert.strictEqual(failure?.id, invalidId);
      assert.strictEqual(failure?.displayName, "invalid stored settings");
      assert.strictEqual(failure?.workspaceLimit, 3);
      const liveIssueTracker = findWorkspaceIssueTracker(refreshedState, invalidId);
      assert.strictEqual(liveIssueTracker?.type, "github");
      assert.strictEqual(
        findWorkspaceIssueTrackerBinding(refreshedState, invalidId)?.repository,
        "acme/repo",
      );
      assert.strictEqual(refreshedState.failures.length, 1);
      assert.deepStrictEqual(findWorkspace(refreshedState, first.config.id)?.config.worktrees?.setup, [
        "pnpm install",
      ]);

      const reloadedContext = yield* Layer.build(registryLayerAt(storePath));
      const reloaded = Context.get(reloadedContext, WorkspaceRegistry);
      const reloadedState = yield* reloaded.state;

      assert.strictEqual(reloadedState.workspaces.length, 2);
      assert.strictEqual(reloadedState.failures.length, 1);
      assert.strictEqual(reloadedState.failures[0]?.displayName, "invalid stored settings");
      assert.strictEqual(reloadedState.failures[0]?.workspaceLimit, 3);
      const reloadedIssueTracker = findWorkspaceIssueTracker(reloadedState, invalidId);
      assert.strictEqual(reloadedIssueTracker?.type, "github");
      assert.strictEqual(findWorkspaceIssueTrackerBinding(reloadedState, invalidId)?.repository, "acme/repo");
      assert.deepStrictEqual(
        reloadedState.workspaces.map((workspace) => workspace.config.displayName).sort(),
        ["first clone", "first clone"],
      );

      const relativeError = yield* management
        .register(
          registration({
            displayName: "relative",
            checkoutPath: ".",
            issueTracker: { type: "github" },
            linearHistory: false,
          }),
        )
        .pipe(Effect.flip);
      assert.include(relativeError.message, "absolute");
    }),
  );

  it.effect("re-binds identity and deregisters private overlays without deleting Run history", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-workspace-lifecycle-" });
      const storePath = path.join(root, "control.db");
      const firstCheckout = yield* makeCheckout(root, "first");
      const secondCheckout = yield* makeCheckout(root, "second");
      const registryContext = yield* Layer.build(registryLayerAt(storePath));
      const management = Context.get(registryContext, WorkspaceManagement);
      const liveRegistry = Context.get(registryContext, WorkspaceRegistry);
      const registered = yield* management.register(
        registration({
          displayName: "moving workspace",
          checkoutPath: firstCheckout,
          issueTracker: { type: "github" },
          sourceControl: { type: "github" },
          linearHistory: true,
          concurrency: 2,
        }),
      );
      if (registered._tag === "Failed") return assert.fail("expected registration to succeed");
      const workspace = registered.workspace.config.id;
      const privateTree = path.join(root, "workspaces", workspace);
      yield* fs.makeDirectory(privateTree, { recursive: true });
      yield* fs.writeFileString(path.join(privateTree, "private.md"), "private");
      yield* Effect.flatMap(SqlClient.SqlClient, (sql) =>
        Effect.all([
          sql`INSERT INTO runs (
              id, workspace, work_item, operation, harness, status, started_at
            ) VALUES (
              'run-before-deregister', ${workspace}, '#222', 'implement', 'codex', 'succeeded', 1
            )`,
          sql`INSERT INTO operation_settings (
              setting, scope, workspace, value
            ) VALUES
              ('model', 'private-workspace-overlay', ${workspace}, '"overlay-model"'),
              ('model', 'private-workspace-overlay', 'other-workspace', '"other-model"')`,
          sql`INSERT INTO contribution_settings (
              contribution, scope, workspace, enabled
            ) VALUES
              ('repo-tools', 'private-workspace-overlay', ${workspace}, 1),
              ('other-tools', 'private-workspace-overlay', 'other-workspace', 1)`,
        ]),
      ).pipe(Effect.provide(controlStoreClientLayer(storePath)));

      const renamedUpdate = workspaceUpdate({
        displayName: "renamed workspace",
        issueTracker: { type: "linear", teams: ["ENG"] },
        sourceControl: { type: "github" },
        mcpSkills: [],
        linearHistory: false,
        worktrees: { baseBranch: "trunk", setup: ["pnpm install"] },
        concurrency: 4,
      });
      const updated = yield* management.update(workspace, renamedUpdate);
      if (updated._tag === "Failed") return assert.fail("expected update to succeed");
      assert.strictEqual(updated.workspace.config.id, workspace);
      assert.strictEqual(updated.workspace.config.checkoutPath, firstCheckout);
      assert.strictEqual(updated.workspace.config.displayName, "renamed workspace");
      assert.strictEqual(updated.workspace.config.issueTracker.type, "linear");
      assert.strictEqual(updated.workspace.workspaceLimit, 4);
      assert.deepStrictEqual(
        updated.workspace.record,
        registration({
          displayName: "renamed workspace",
          checkoutPath: firstCheckout,
          issueTracker: { type: "linear", connectionId: "unbound", teams: ["ENG"] },
          sourceControl: {
            type: "github",
            connectionId: "unbound",
          },
          mcpSkills: [],
          linearHistory: false,
          worktrees: { baseBranch: "trunk", setup: ["pnpm install"] },
          concurrency: 4,
        }),
      );
      const overlaysAfterUpdate = yield* Effect.flatMap(
        SqlClient.SqlClient,
        (sql) =>
          sql<{ readonly workspace: string }>`SELECT workspace FROM operation_settings ORDER BY workspace`,
      ).pipe(Effect.provide(controlStoreClientLayer(storePath)));
      assert.deepStrictEqual(overlaysAfterUpdate, [{ workspace }, { workspace: "other-workspace" }]);

      const rebound = yield* management.rebind(workspace, secondCheckout);
      if (rebound._tag === "Failed") return assert.fail("expected re-bind to succeed");
      assert.strictEqual(rebound.workspace.config.id, workspace);
      assert.strictEqual(rebound.workspace.config.checkoutPath, secondCheckout);
      assert.strictEqual(rebound.workspace.repository, "acme/repo");
      assert.strictEqual(rebound.workspace.workspaceLimit, 4);
      assert.isTrue(yield* fs.exists(privateTree));
      const overlaysAfterRebind = yield* Effect.flatMap(
        SqlClient.SqlClient,
        (sql) =>
          sql<{ readonly workspace: string }>`SELECT workspace FROM operation_settings ORDER BY workspace`,
      ).pipe(Effect.provide(controlStoreClientLayer(storePath)));
      assert.deepStrictEqual(overlaysAfterRebind, [{ workspace }, { workspace: "other-workspace" }]);

      assert.strictEqual(yield* management.deregister(workspace), workspace);
      assert.isUndefined(findWorkspace(yield* liveRegistry.state, workspace));
      assert.isFalse(yield* fs.exists(privateTree));
      const runs = yield* Effect.flatMap(
        SqlClient.SqlClient,
        (sql) =>
          sql<{ readonly id: string; readonly workspace: string }>`
          SELECT id, workspace FROM runs WHERE id = 'run-before-deregister'
        `,
      ).pipe(Effect.provide(controlStoreClientLayer(storePath)));
      assert.deepStrictEqual(runs, [{ id: "run-before-deregister", workspace }]);
      const overlaysAfterDeregister = yield* Effect.flatMap(
        SqlClient.SqlClient,
        (sql) =>
          sql<{ readonly workspace: string }>`SELECT workspace FROM operation_settings ORDER BY workspace`,
      ).pipe(Effect.provide(controlStoreClientLayer(storePath)));
      assert.deepStrictEqual(overlaysAfterDeregister, [{ workspace: "other-workspace" }]);
      const contributionOverlaysAfterDeregister = yield* Effect.flatMap(
        SqlClient.SqlClient,
        (sql) =>
          sql<{ readonly workspace: string }>`SELECT workspace FROM contribution_settings ORDER BY workspace`,
      ).pipe(Effect.provide(controlStoreClientLayer(storePath)));
      assert.deepStrictEqual(contributionOverlaysAfterDeregister, [{ workspace: "other-workspace" }]);

      const missingUpdate = yield* management.update(workspace, renamedUpdate).pipe(Effect.flip);
      assert.strictEqual(missingUpdate._tag, "WorkspaceRegistryError");
      assert.strictEqual(missingUpdate.reason, "not-found");

      const registeredAgain = yield* management.register(
        githubRegistration("moving workspace", secondCheckout),
      );
      if (registeredAgain._tag === "Failed") return assert.fail("expected re-registration to succeed");
      assert.notStrictEqual(registeredAgain.workspace.config.id, workspace);
    }),
  );

  it.effect("rolls back deregistration when the private tree cannot be removed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-workspace-rollback-" });
      const storePath = path.join(root, "control.db");
      const checkoutPath = yield* makeCheckout(root, "rollback");
      const privateRoot = path.join(root, "workspaces");
      const failure = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "remove",
      });
      const failingFileSystem = FileSystem.FileSystem.of({
        ...fs,
        remove: (file, options) =>
          file.startsWith(privateRoot) ? Effect.fail(failure) : fs.remove(file, options),
      });
      const registryContext = yield* Layer.build(
        registryLayerAt(storePath).pipe(
          Layer.provide(Layer.succeed(FileSystem.FileSystem, failingFileSystem)),
        ),
      );
      const management = Context.get(registryContext, WorkspaceManagement);
      const liveRegistry = Context.get(registryContext, WorkspaceRegistry);
      const registered = yield* management.register(githubRegistration("rollback", checkoutPath));
      if (registered._tag === "Failed") return assert.fail("expected registration to succeed");
      const workspace = registered.workspace.config.id;
      const privateTree = path.join(privateRoot, workspace);
      yield* fs.makeDirectory(privateTree, { recursive: true });

      const deregistration = yield* management.deregister(workspace).pipe(Effect.flip);

      assert.strictEqual(deregistration._tag, "WorkspaceRegistryError");
      assert.strictEqual(deregistration.reason, "management-failed");
      assert.isDefined(findWorkspace(yield* liveRegistry.state, workspace));
      assert.isTrue(yield* fs.exists(privateTree));
      const rows = yield* Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql<{ readonly id: string }>`SELECT id FROM workspaces WHERE id = ${workspace}`,
      ).pipe(Effect.provide(controlStoreClientLayer(storePath)));
      assert.deepStrictEqual(rows, [{ id: workspace }]);
    }),
  );
});
