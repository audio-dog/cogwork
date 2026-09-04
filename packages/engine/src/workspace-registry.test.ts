import { WorkspaceRegistration, WorkspaceUpdate } from "@cogwork/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, layer } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { controlStoreClientLayer } from "./control-store";
import * as Registry from "./registry";

const registration = Schema.decodeSync(WorkspaceRegistration);
const workspaceUpdate = Schema.decodeSync(WorkspaceUpdate);

const githubRegistration = (name: string, checkoutPath: string) =>
  registration({
    name,
    checkoutPath,
    issueTracker: { type: "github", repo: "acme/repo" },
    linearHistory: false,
  });

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

const makeCheckout = Effect.fn("test.makeCheckout")(function* (root: string, name: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const checkoutPath = path.join(root, name);
  yield* fs.makeDirectory(path.join(checkoutPath, ".agents"), { recursive: true });
  return checkoutPath;
});

const makeProbedCheckout = Effect.fn("test.makeProbedCheckout")(function* (root: string, name: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const checkoutPath = yield* makeCheckout(root, name);
  const rulesPath = path.join(checkoutPath, ".agents", "rules");
  yield* fs.makeDirectory(rulesPath, { recursive: true });
  yield* fs.writeFileString(
    path.join(rulesPath, "project.md"),
    '---\ndescription: project\nglobs: "**/*"\nalwaysApply: true\n---\nProject rules',
  );
  return checkoutPath;
});

layer(NodeServices.layer)((it) => {
  it.effect("refuses registration when the Control store is unavailable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-workspace-registry-health-" });
      const storePath = path.join(root, "control.db");
      const checkoutPath = yield* makeCheckout(root, "unavailable");
      yield* Layer.build(Registry.layerAt(storePath));
      const registryContext = yield* Layer.build(
        Registry.layer(storePath, `${storePath}.agents`).pipe(
          Layer.provide(controlStoreClientLayer(storePath)),
        ),
      );
      const management = Context.get(registryContext, Registry.WorkspaceManagement);

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
      const registryContext = yield* Layer.build(Registry.layerAt(storePath));
      const management = Context.get(registryContext, Registry.WorkspaceManagement);
      const liveRegistry = Context.get(registryContext, Registry.WorkspaceRegistry);
      const first = yield* management.register(githubRegistration("first", checkoutPath));
      if (first._tag === "Failed") return assert.fail("expected registration to succeed");
      const duplicate = yield* management
        .register(githubRegistration("duplicate", `${checkoutPath}/./`))
        .pipe(Effect.flip);

      assert.include(duplicate.message, `already registered as ${first.workspace.config.name}`);
      assert.strictEqual((yield* liveRegistry.state).workspaces.length, 1);
    }),
  );

  it.effect("loads registered workspaces without booting the Control store", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-workspace-registry-read-" });
      const storePath = path.join(root, "control.db");
      const checkoutPath = yield* makeCheckout(root, "read-only");
      const writableContext = yield* Layer.build(Registry.layerAt(storePath));
      const management = Context.get(writableContext, Registry.WorkspaceManagement);
      const change = yield* management.register(githubRegistration("read-only", checkoutPath));
      if (change._tag === "Failed") return assert.fail("expected registration to succeed");
      yield* Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql`CREATE TABLE read_only_probe (id INTEGER PRIMARY KEY)`,
      ).pipe(Effect.provide(controlStoreClientLayer(storePath)));

      const readOnlyContext = yield* Layer.build(Registry.readOnlyLayerAt(storePath));
      const reloaded = Context.get(readOnlyContext, Registry.WorkspaceRegistry);

      assert.isDefined(Registry.findWorkspace(yield* reloaded.state, change.workspace.config.name));
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
      const context = yield* Layer.build(Registry.layerAt(storePath));
      const management = Context.get(context, Registry.WorkspaceManagement);
      const change = yield* management.register(
        registration({
          name: "settings",
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
      const reloadedContext = yield* Layer.build(Registry.layerAt(storePath));
      const [reloaded] = (yield* Context.get(reloadedContext, Registry.WorkspaceRegistry).state).workspaces;

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

  it.effect("registers a workspace without repository settings", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-workspace-registry-bare-" });
      const storePath = path.join(root, "control.db");
      const checkoutPath = path.join(root, "bare");
      yield* fs.makeDirectory(checkoutPath, { recursive: true });
      const context = yield* Layer.build(Registry.layerAt(storePath));
      const management = Context.get(context, Registry.WorkspaceManagement);

      const change = yield* management.register(githubRegistration("bare", checkoutPath));

      if (change._tag === "Failed")
        return assert.fail(`expected registration to succeed: ${change.failure.message}`);
      assert.isUndefined(change.workspace.config.worktrees);
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
        Registry.layerAt(storePath).pipe(Layer.provide(fileSystemLayer)),
      );
      const management = Context.get(registryContext, Registry.WorkspaceManagement);
      const liveRegistry = Context.get(registryContext, Registry.WorkspaceRegistry);
      yield* management.register(githubRegistration("first", firstCheckout));
      yield* Ref.set(gated, true);
      const refreshing = yield* liveRegistry.refresh.pipe(Effect.forkChild);
      yield* Deferred.await(refreshRead);
      const second = yield* management.register(githubRegistration("second", secondCheckout));
      if (second._tag === "Failed") return assert.fail("expected registration to succeed");
      yield* Deferred.succeed(releaseRefresh, undefined);
      yield* Fiber.join(refreshing);

      assert.isDefined(Registry.findWorkspace(yield* liveRegistry.state, second.workspace.config.name));
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
        Registry.layerAt(storePath).pipe(Layer.provide(fileSystemLayer)),
      );
      const management = Context.get(registryContext, Registry.WorkspaceManagement);
      const liveRegistry = Context.get(registryContext, Registry.WorkspaceRegistry);
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
          (workspace) => workspace.config.name === change.workspace.config.name,
        ).length,
        1,
      );
    }),
  );

  it.effect("mints identities, keeps clone hints non-identifying, and reloads from the Control store", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-workspace-registry-" });
      const storePath = path.join(root, "control.db");
      const firstCheckout = yield* makeCheckout(root, "first");
      const secondCheckout = yield* makeCheckout(root, "second");
      const invalidCheckout = yield* makeCheckout(root, "invalid");

      const registryContext = yield* Layer.build(Registry.layerAt(storePath));
      const management = Context.get(registryContext, Registry.WorkspaceManagement);
      const liveRegistry = Context.get(registryContext, Registry.WorkspaceRegistry);
      const firstChange = yield* management.register(
        registration({
          name: "first clone",
          checkoutPath: firstCheckout,
          gitRemote: "git@github.com:acme/repo.git",
          issueTracker: { type: "github", repo: "acme/repo" },
          sourceControl: { type: "github", repo: "acme/repo" },
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
          name: "first clone",
          checkoutPath: secondCheckout,
          gitRemote: "git@github.com:acme/repo.git",
          issueTracker: { type: "github", repo: "acme/repo" },
          linearHistory: false,
        }),
      );
      const invalidChange = yield* management.register(
        registration({
          name: "invalid stored settings",
          checkoutPath: invalidCheckout,
          issueTracker: { type: "github", repo: "acme/repo" },
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
      assert.notStrictEqual(first.config.name, second.config.name);
      assert.strictEqual(first.config.displayName, "first clone");
      assert.strictEqual(second.config.displayName, "first clone");
      const state = yield* liveRegistry.state;
      assert.isUndefined(Registry.findWorkspace(state, "first clone"));
      assert.strictEqual(Registry.findWorkspace(state, first.config.name), first);
      assert.strictEqual(Registry.findWorkspace(state, second.config.name), second);
      assert.strictEqual(first.workspaceLimit, 2);
      assert.deepStrictEqual(first.config.worktrees, {
        root: path.join(root, "worktrees"),
        remote: "upstream",
        baseBranch: "trunk",
        setup: ["pnpm install"],
        linkPaths: [".env"],
      });
      const invalidName = invalidChange.workspace.config.name;
      yield* Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql`UPDATE workspaces SET mcp_skills = '{ not json' WHERE id = ${invalidName}`,
      ).pipe(Effect.provide(controlStoreClientLayer(storePath)));
      yield* liveRegistry.refresh;
      const refreshedState = yield* liveRegistry.state;
      const [failure] = refreshedState.failures;
      assert.strictEqual(failure?.name, invalidName);
      assert.strictEqual(failure?.displayName, "invalid stored settings");
      assert.strictEqual(failure?.workspaceLimit, 3);
      const liveIssueTracker = Registry.findWorkspaceIssueTracker(refreshedState, invalidName);
      assert.strictEqual(liveIssueTracker?.type, "github");
      assert.strictEqual(liveIssueTracker?.repo, "acme/repo");
      assert.strictEqual(refreshedState.failures.length, 1);
      assert.deepStrictEqual(
        Registry.findWorkspace(refreshedState, first.config.name)?.config.worktrees?.setup,
        ["pnpm install"],
      );

      const reloadedContext = yield* Layer.build(Registry.layerAt(storePath));
      const reloaded = Context.get(reloadedContext, Registry.WorkspaceRegistry);
      const reloadedState = yield* reloaded.state;

      assert.strictEqual(reloadedState.workspaces.length, 2);
      assert.strictEqual(reloadedState.failures.length, 1);
      assert.strictEqual(reloadedState.failures[0]?.displayName, "invalid stored settings");
      assert.strictEqual(reloadedState.failures[0]?.workspaceLimit, 3);
      const reloadedIssueTracker = Registry.findWorkspaceIssueTracker(reloadedState, invalidName);
      assert.strictEqual(reloadedIssueTracker?.type, "github");
      assert.strictEqual(reloadedIssueTracker?.repo, "acme/repo");
      assert.deepStrictEqual(
        reloadedState.workspaces.map((workspace) => workspace.config.displayName).sort(),
        ["first clone", "first clone"],
      );

      const relativeError = yield* management
        .register(
          registration({
            name: "relative",
            checkoutPath: ".",
            issueTracker: { type: "github", repo: "acme/repo" },
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
      const registryContext = yield* Layer.build(Registry.layerAt(storePath));
      const management = Context.get(registryContext, Registry.WorkspaceManagement);
      const liveRegistry = Context.get(registryContext, Registry.WorkspaceRegistry);
      const registered = yield* management.register(
        registration({
          name: "moving workspace",
          checkoutPath: firstCheckout,
          gitRemote: "git@github.com:acme/repo.git",
          issueTracker: { type: "github", repo: "acme/repo" },
          sourceControl: { type: "github", repo: "acme/repo" },
          linearHistory: true,
          concurrency: 2,
        }),
      );
      if (registered._tag === "Failed") return assert.fail("expected registration to succeed");
      const workspace = registered.workspace.config.name;
      const privateTree = path.join(root, "workspaces", workspace);
      yield* fs.makeDirectory(privateTree, { recursive: true });
      yield* fs.writeFileString(path.join(privateTree, "private.md"), "private");
      yield* Effect.flatMap(SqlClient.SqlClient, (sql) =>
        Effect.all([
          sql`INSERT INTO runs (
              id, workspace, work_item, stage, harness, status, started_at
            ) VALUES (
              'run-before-deregister', ${workspace}, '#222', 'implement', 'codex', 'succeeded', 1
            )`,
          sql`INSERT INTO operation_settings (
              setting, level, workflow, operation, scope, workspace, value
            ) VALUES
              ('model', 'default', '', '', 'private-workspace-overlay', ${workspace}, '"overlay-model"'),
              ('model', 'default', '', '', 'private-workspace-overlay', 'other-workspace', '"other-model"')`,
          sql`INSERT INTO contribution_settings (
              contribution, scope, workspace, enabled
            ) VALUES
              ('repo-tools', 'private-workspace-overlay', ${workspace}, 1),
              ('other-tools', 'private-workspace-overlay', 'other-workspace', 1)`,
        ]),
      ).pipe(Effect.provide(controlStoreClientLayer(storePath)));

      const renamedUpdate = workspaceUpdate({
        name: "renamed workspace",
        gitRemote: "git@github.com:acme/renamed.git",
        issueTracker: { type: "linear", teams: ["ENG"] },
        sourceControl: { type: "github", repo: "acme/renamed" },
        mcpSkills: [],
        linearHistory: false,
        worktrees: { baseBranch: "trunk", setup: ["pnpm install"] },
        concurrency: 4,
      });
      const updated = yield* management.update(workspace, renamedUpdate);
      if (updated._tag === "Failed") return assert.fail("expected update to succeed");
      assert.strictEqual(updated.workspace.config.name, workspace);
      assert.strictEqual(updated.workspace.config.checkoutPath, firstCheckout);
      assert.strictEqual(updated.workspace.config.displayName, "renamed workspace");
      assert.strictEqual(updated.workspace.config.issueTracker.type, "linear");
      assert.strictEqual(updated.workspace.workspaceLimit, 4);
      assert.deepStrictEqual(
        updated.workspace.record,
        registration({
          name: "renamed workspace",
          checkoutPath: firstCheckout,
          gitRemote: "git@github.com:acme/renamed.git",
          issueTracker: { type: "linear", connectionId: "unbound", teams: ["ENG"] },
          sourceControl: {
            type: "github",
            connectionId: "unbound",
            repo: "acme/renamed",
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
      assert.strictEqual(rebound.workspace.config.name, workspace);
      assert.strictEqual(rebound.workspace.config.checkoutPath, secondCheckout);
      assert.strictEqual(rebound.workspace.config.sourceControl?.repo, "acme/renamed");
      assert.strictEqual(rebound.workspace.workspaceLimit, 4);
      assert.isTrue(yield* fs.exists(privateTree));
      const overlaysAfterRebind = yield* Effect.flatMap(
        SqlClient.SqlClient,
        (sql) =>
          sql<{ readonly workspace: string }>`SELECT workspace FROM operation_settings ORDER BY workspace`,
      ).pipe(Effect.provide(controlStoreClientLayer(storePath)));
      assert.deepStrictEqual(overlaysAfterRebind, [{ workspace }, { workspace: "other-workspace" }]);

      assert.strictEqual(yield* management.deregister(workspace), workspace);
      assert.isUndefined(Registry.findWorkspace(yield* liveRegistry.state, workspace));
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
      assert.strictEqual(missingUpdate._tag, "WorkspaceNotFound");

      const registeredAgain = yield* management.register(
        githubRegistration("moving workspace", secondCheckout),
      );
      if (registeredAgain._tag === "Failed") return assert.fail("expected re-registration to succeed");
      assert.notStrictEqual(registeredAgain.workspace.config.name, workspace);
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
        Registry.layerAt(storePath).pipe(
          Layer.provide(Layer.succeed(FileSystem.FileSystem, failingFileSystem)),
        ),
      );
      const management = Context.get(registryContext, Registry.WorkspaceManagement);
      const liveRegistry = Context.get(registryContext, Registry.WorkspaceRegistry);
      const registered = yield* management.register(githubRegistration("rollback", checkoutPath));
      if (registered._tag === "Failed") return assert.fail("expected registration to succeed");
      const workspace = registered.workspace.config.name;
      const privateTree = path.join(privateRoot, workspace);
      yield* fs.makeDirectory(privateTree, { recursive: true });

      const deregistration = yield* management.deregister(workspace).pipe(Effect.flip);

      assert.strictEqual(deregistration._tag, "WorkspaceManagementError");
      assert.isDefined(Registry.findWorkspace(yield* liveRegistry.state, workspace));
      assert.isTrue(yield* fs.exists(privateTree));
      const rows = yield* Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql<{ readonly id: string }>`SELECT id FROM workspaces WHERE id = ${workspace}`,
      ).pipe(Effect.provide(controlStoreClientLayer(storePath)));
      assert.deepStrictEqual(rows, [{ id: workspace }]);
    }),
  );

  it.effect("admits only registered repository and WorkspaceId-private Authoring trees", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-workspace-authoring-" });
      const storePath = path.join(root, "control.db");
      const firstCheckout = yield* makeCheckout(root, "first");
      const secondCheckout = yield* makeCheckout(root, "second");
      const unregisteredCheckout = yield* makeCheckout(root, "unregistered");
      const repoSkill = path.join(firstCheckout, ".agents", "skills", "shared", "SKILL.md");
      yield* fs.makeDirectory(path.dirname(repoSkill), { recursive: true });
      yield* fs.writeFileString(repoSkill, "repo Skill");
      const ignoredSkill = path.join(unregisteredCheckout, ".agents", "skills", "ignored", "SKILL.md");
      yield* fs.makeDirectory(path.dirname(ignoredSkill), { recursive: true });
      yield* fs.writeFileString(ignoredSkill, "unregistered Skill");

      const registryContext = yield* Layer.build(Registry.layerAt(storePath));
      const management = Context.get(registryContext, Registry.WorkspaceManagement);
      const liveRegistry = Context.get(registryContext, Registry.WorkspaceRegistry);
      const firstChange = yield* management.register(githubRegistration("first", firstCheckout));
      const secondChange = yield* management.register(githubRegistration("second", secondCheckout));
      if (firstChange._tag === "Failed" || secondChange._tag === "Failed") {
        return assert.fail("expected valid Workspace inputs to register");
      }
      const privateSkill = path.join(
        root,
        "workspaces",
        firstChange.workspace.config.name,
        "skills",
        "shared",
        "SKILL.md",
      );
      yield* fs.makeDirectory(path.dirname(privateSkill), { recursive: true });
      yield* fs.writeFileString(privateSkill, "private Skill");
      yield* liveRegistry.refresh;

      const state = yield* liveRegistry.state;
      const first = Registry.findWorkspace(state, firstChange.workspace.config.name);
      const second = Registry.findWorkspace(state, secondChange.workspace.config.name);
      assert.deepStrictEqual(
        first?.contributions?.map((entry) => entry.id),
        ["local:private/skill/shared", "local:repo/skill/shared"],
      );
      assert.deepStrictEqual(second?.contributions, []);
      assert.isFalse(
        state.workspaces.some(
          (workspace) => workspace.contributions?.some((entry) => entry.localName === "ignored") ?? false,
        ),
      );
    }),
  );

  it.effect("publishes user Authoring tree contributions with each registered workspace", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-workspace-user-authoring-" });
      const storePath = path.join(root, "control.db");
      const userAgentsDir = path.join(root, ".agents");
      const checkoutPath = yield* makeCheckout(root, "user-tree");
      const userSkill = path.join(userAgentsDir, "skills", "commit", "SKILL.md");
      yield* fs.makeDirectory(path.dirname(userSkill), { recursive: true });
      yield* fs.writeFileString(userSkill, "user Skill");

      const registryContext = yield* Layer.build(Registry.layerAt(storePath, userAgentsDir));
      const management = Context.get(registryContext, Registry.WorkspaceManagement);
      const change = yield* management.register(githubRegistration("user-tree", checkoutPath));
      if (change._tag === "Failed") return assert.fail("expected registration to succeed");

      assert.deepStrictEqual(
        change.workspace.contributions.map((entry) => entry.id),
        ["local:user/skill/commit"],
      );
    }),
  );
});
