import { WorkspaceInput, WorkspaceRegistration } from "@cogwork/contracts";
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
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { controlStoreClientLayer } from "./control-store";
import * as Registry from "./registry";

const workspaceInput = Schema.decodeSync(WorkspaceInput)({
  harness: { preferred: "codex" },
  playbook: { implement: { enabled: true } },
  worktrees: { setup: ["pnpm install"], linkPaths: [".env"] },
});
const changedWorkspaceInput = Schema.decodeSync(WorkspaceInput)({
  ...workspaceInput,
  worktrees: { setup: ["pnpm test"], linkPaths: [".env"] },
});
const encodeWorkspaceInput = Schema.encodeSync(Schema.fromJsonString(WorkspaceInput));
const registration = Schema.decodeSync(WorkspaceRegistration);

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
  const agentsPath = path.join(checkoutPath, ".agents");
  yield* fs.makeDirectory(agentsPath, { recursive: true });
  yield* fs.writeFileString(path.join(agentsPath, "workspace.json"), encodeWorkspaceInput(workspaceInput));
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
        Registry.layer(storePath).pipe(Layer.provide(controlStoreClientLayer(storePath))),
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
      assert.strictEqual(liveRegistry.workspaces.length, 1);
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

      assert.isDefined(Registry.findWorkspace(reloaded, change.workspace.config.name));
    }),
  );

  it.effect("keeps a registration made while refresh is loading", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-workspace-registry-stale-" });
      const storePath = path.join(root, "control.db");
      const firstCheckout = yield* makeCheckout(root, "first");
      const secondCheckout = yield* makeCheckout(root, "second");
      const gated = yield* Ref.make(false);
      const gatedReads = yield* Ref.make(0);
      const refreshRead = yield* Deferred.make<void>();
      const releaseRefresh = yield* Deferred.make<void>();
      const gatedFileSystem = FileSystem.FileSystem.of({
        ...fs,
        readFileString: (file, encoding) =>
          Ref.get(gated).pipe(
            Effect.flatMap((enabled) => {
              if (!enabled) return fs.readFileString(file, encoding);
              return Ref.getAndUpdate(gatedReads, (count) => count + 1).pipe(
                Effect.flatMap((count) => {
                  if (count > 0) return fs.readFileString(file, encoding);
                  return Deferred.succeed(refreshRead, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseRefresh)),
                    Effect.andThen(fs.readFileString(file, encoding)),
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

      assert.isDefined(Registry.findWorkspace(liveRegistry, second.workspace.config.name));
    }),
  );

  it.effect("keeps one workspace when registration overlaps refresh", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-workspace-registry-race-" });
      const storePath = path.join(root, "control.db");
      const checkoutPath = yield* makeCheckout(root, "race");
      const reads = yield* Ref.make(0);
      const registerRead = yield* Deferred.make<void>();
      const refreshRead = yield* Deferred.make<void>();
      const releaseRegister = yield* Deferred.make<void>();
      const releaseRefresh = yield* Deferred.make<void>();
      const gatedFileSystem = FileSystem.FileSystem.of({
        ...fs,
        readFileString: (file, encoding) =>
          Ref.getAndUpdate(reads, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              orderedRead(count, registerRead, releaseRegister, refreshRead, releaseRefresh),
            ),
            Effect.andThen(fs.readFileString(file, encoding)),
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
        liveRegistry.workspaces.filter((workspace) => workspace.config.name === change.workspace.config.name)
          .length,
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
      const missingCheckout = path.join(root, "missing");
      yield* fs.makeDirectory(missingCheckout);

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
          worktrees: { root: path.join(root, "worktrees"), remote: "upstream", baseBranch: "trunk" },
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
      const missingChange = yield* management.register(
        registration({
          name: "missing input",
          checkoutPath: missingCheckout,
          issueTracker: { type: "github", repo: "acme/repo" },
          linearHistory: false,
          concurrency: 3,
        }),
      );
      if (firstChange._tag === "Failed" || secondChange._tag === "Failed") {
        return assert.fail("expected valid Workspace inputs to register");
      }
      const first = firstChange.workspace;
      const second = secondChange.workspace;
      assert.notStrictEqual(first.config.name, second.config.name);
      assert.strictEqual(first.config.displayName, "first clone");
      assert.strictEqual(second.config.displayName, "first clone");
      assert.isUndefined(Registry.findWorkspace(liveRegistry, "first clone"));
      assert.strictEqual(Registry.findWorkspace(liveRegistry, first.config.name), first);
      assert.strictEqual(Registry.findWorkspace(liveRegistry, second.config.name), second);
      assert.strictEqual(first.workspaceLimit, 2);
      assert.deepStrictEqual(first.config.worktrees, {
        root: path.join(root, "worktrees"),
        remote: "upstream",
        baseBranch: "trunk",
        setup: ["pnpm install"],
        linkPaths: [".env"],
      });
      assert.strictEqual(missingChange._tag, "Failed");
      if (missingChange._tag !== "Failed") return assert.fail("expected missing input diagnostic");
      if (missingChange.failure.name === undefined) return assert.fail("expected minted workspace identity");
      const missingName = missingChange.failure.name;
      assert.strictEqual(missingChange.failure.displayName, "missing input");
      assert.strictEqual(missingChange.failure.workspaceLimit, 3);
      const liveIssueTracker = Registry.findWorkspaceIssueTracker(liveRegistry, missingName);
      assert.strictEqual(liveIssueTracker?.type, "github");
      assert.strictEqual(liveIssueTracker?.repo, "acme/repo");
      assert.strictEqual(liveRegistry.failures.length, 1);

      yield* fs.writeFileString(
        path.join(firstCheckout, ".agents", "workspace.json"),
        encodeWorkspaceInput(changedWorkspaceInput),
      );
      yield* liveRegistry.refresh;
      assert.deepStrictEqual(
        Registry.findWorkspace(liveRegistry, first.config.name)?.config.worktrees?.setup,
        ["pnpm test"],
      );

      const reloadedContext = yield* Layer.build(Registry.layerAt(storePath));
      const reloaded = Context.get(reloadedContext, Registry.WorkspaceRegistry);

      assert.strictEqual(reloaded.workspaces.length, 2);
      assert.strictEqual(reloaded.failures.length, 1);
      assert.strictEqual(reloaded.failures[0]?.displayName, "missing input");
      assert.strictEqual(reloaded.failures[0]?.workspaceLimit, 3);
      const reloadedIssueTracker = Registry.findWorkspaceIssueTracker(reloaded, missingName);
      assert.strictEqual(reloadedIssueTracker?.type, "github");
      assert.strictEqual(reloadedIssueTracker?.repo, "acme/repo");
      assert.deepStrictEqual(reloaded.workspaces.map((workspace) => workspace.config.displayName).sort(), [
        "first clone",
        "first clone",
      ]);

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

      const first = Registry.findWorkspace(liveRegistry, firstChange.workspace.config.name);
      const second = Registry.findWorkspace(liveRegistry, secondChange.workspace.config.name);
      assert.deepStrictEqual(
        first?.contributions?.map((entry) => entry.id),
        ["local:private/skill/shared", "local:repo/skill/shared"],
      );
      assert.deepStrictEqual(second?.contributions, []);
      assert.isFalse(
        liveRegistry.workspaces.some(
          (workspace) => workspace.contributions?.some((entry) => entry.localName === "ignored") ?? false,
        ),
      );
    }),
  );
});
