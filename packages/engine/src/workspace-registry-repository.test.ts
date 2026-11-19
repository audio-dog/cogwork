import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, layer } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import { controlStoreClientLayer } from "./control-store";
import { GitError } from "./git";
import { layerAt } from "./registry";
import { findWorkspace, findWorkspaceIssueTrackerBinding } from "./registry-lookup";
import { WorkspaceManagement } from "./registry-management";
import { WorkspaceRegistry } from "./registry-service";
import {
  githubRegistration,
  gitLayerFor,
  makeCheckout,
  RemoteUrls,
  registration,
  remoteUrlsGitLayer,
} from "./workspace-registry-fixtures";

layer(Layer.merge(NodeServices.layer, NodeCrypto.layerSecureRandom))((it) => {
  it.effect("derives GitHub repositories from the selected checkout remote", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-workspace-registry-repository-" });
      const storePath = path.join(root, "control.db");
      const githubCheckout = yield* makeCheckout(root, "github");
      const linearCheckout = yield* makeCheckout(root, "linear");
      const reboundCheckout = yield* makeCheckout(root, "rebound");
      const remotes = yield* RemoteUrls;
      yield* Ref.set(
        remotes,
        new Map([
          [`${githubCheckout}:upstream`, "git@github.com:colonylabs/cogwork.git"],
          [`${linearCheckout}:origin`, "https://github.com/colonylabs/linear-work.git"],
          [`${reboundCheckout}:upstream`, "ssh://git@github.com/colonylabs/rebound.git"],
        ]),
      );
      const context = yield* Layer.build(layerAt(storePath).pipe(Layer.provide(remoteUrlsGitLayer)));
      const management = Context.get(context, WorkspaceManagement);
      const registry = Context.get(context, WorkspaceRegistry);

      const github = yield* management.register(
        registration({
          displayName: "github",
          checkoutPath: githubCheckout,
          issueTracker: { type: "github" },
          worktrees: { remote: "upstream" },
        }),
      );
      const linear = yield* management.register(
        registration({
          displayName: "linear",
          checkoutPath: linearCheckout,
          issueTracker: { type: "linear", teams: ["ENG"] },
          sourceControl: { type: "github" },
        }),
      );

      if (github._tag === "Failed" || linear._tag === "Failed") {
        return assert.fail("expected registrations to succeed");
      }
      assert.strictEqual(github.workspace.repository, "colonylabs/cogwork");
      assert.strictEqual(linear.workspace.repository, "colonylabs/linear-work");

      yield* Ref.update(remotes, (values) =>
        new Map(values).set(`${githubCheckout}:upstream`, "https://github.com/colonylabs/refreshed.git"),
      );
      yield* registry.refresh;
      assert.strictEqual(
        findWorkspace(yield* registry.state, github.workspace.config.id)?.repository,
        "colonylabs/refreshed",
      );

      const rebound = yield* management.rebind(github.workspace.config.id, reboundCheckout);
      if (rebound._tag === "Failed") return assert.fail("expected re-bind to succeed");
      assert.strictEqual(rebound.workspace.repository, "colonylabs/rebound");

      const stored = yield* Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql<{ readonly issueTracker: string; readonly sourceControl: string | null }>`
          SELECT issue_tracker AS issueTracker, source_control AS sourceControl
          FROM workspaces
          ORDER BY name
        `,
      ).pipe(Effect.provide(controlStoreClientLayer(storePath)));
      assert.isFalse(stored.some((row) => row.issueTracker.includes('"repo"')));
      assert.isFalse(stored.some((row) => row.sourceControl?.includes('"repo"') ?? false));
    }).pipe(Effect.provide(RemoteUrls.layer)),
  );

  it.effect.each([
    {
      name: "https-user",
      remoteUrl: "https://x-access-token@github.com/colonylabs/https-user.git",
      repository: "colonylabs/https-user",
    },
    {
      name: "ssh-port",
      remoteUrl: "ssh://git@ssh.github.com:443/colonylabs/ssh-port.git",
      repository: "colonylabs/ssh-port",
    },
  ])("accepts the official GitHub $name remote form", ({ name, remoteUrl, repository }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: `cogwork-workspace-registry-${name}-` });
      const storePath = path.join(root, "control.db");
      const checkoutPath = yield* makeCheckout(root, name);
      const remotes = yield* RemoteUrls;
      yield* Ref.set(remotes, new Map([[`${checkoutPath}:origin`, remoteUrl]]));
      const context = yield* Layer.build(layerAt(storePath).pipe(Layer.provide(remoteUrlsGitLayer)));
      const management = Context.get(context, WorkspaceManagement);
      const change = yield* management.register(githubRegistration(name, checkoutPath));

      if (change._tag === "Failed") return assert.fail("expected registration to succeed");
      assert.strictEqual(change.workspace.repository, repository);
    }).pipe(Effect.provide(RemoteUrls.layer)),
  );

  it.effect("keeps the last derived repository when refresh cannot derive the remote", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-workspace-registry-refresh-" });
      const storePath = path.join(root, "control.db");
      const checkoutPath = yield* makeCheckout(root, "refresh");
      const remotes = yield* RemoteUrls;
      yield* Ref.set(remotes, new Map([[`${checkoutPath}:origin`, "git@github.com:acme/repo.git"]]));
      const context = yield* Layer.build(layerAt(storePath).pipe(Layer.provide(remoteUrlsGitLayer)));
      const management = Context.get(context, WorkspaceManagement);
      const registry = Context.get(context, WorkspaceRegistry);
      const change = yield* management.register(githubRegistration("refresh", checkoutPath));
      if (change._tag === "Failed") return assert.fail("expected registration to succeed");

      yield* Ref.set(remotes, new Map([[`${checkoutPath}:origin`, "git@gitlab.com:acme/repo.git"]]));
      const state = yield* registry.refresh;

      assert.strictEqual(
        findWorkspaceIssueTrackerBinding(state, change.workspace.config.id)?.repository,
        "acme/repo",
      );
    }).pipe(Effect.provide(RemoteUrls.layer)),
  );

  it.effect("keeps the last derived repository after restart when the remote cannot be derived", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-workspace-registry-restart-" });
      const storePath = path.join(root, "control.db");
      const checkoutPath = yield* makeCheckout(root, "restart");
      const remotes = yield* RemoteUrls;
      yield* Ref.set(remotes, new Map([[`${checkoutPath}:origin`, "git@github.com:acme/repo.git"]]));
      const initialContext = yield* Layer.build(layerAt(storePath).pipe(Layer.provide(remoteUrlsGitLayer)));
      const management = Context.get(initialContext, WorkspaceManagement);
      const change = yield* management.register(githubRegistration("restart", checkoutPath));
      if (change._tag === "Failed") return assert.fail("expected registration to succeed");

      yield* Ref.set(remotes, new Map([[`${checkoutPath}:origin`, "git@gitlab.com:acme/repo.git"]]));
      const restartedContext = yield* Layer.build(layerAt(storePath).pipe(Layer.provide(remoteUrlsGitLayer)));
      const restartedRegistry = Context.get(restartedContext, WorkspaceRegistry);
      const state = yield* restartedRegistry.state;

      assert.strictEqual(
        findWorkspaceIssueTrackerBinding(state, change.workspace.config.id)?.repository,
        "acme/repo",
      );

      yield* Ref.set(remotes, new Map([[`${checkoutPath}:origin`, "git@github.com:acme/moved.git"]]));
      yield* restartedRegistry.refresh;
      yield* Ref.set(remotes, new Map([[`${checkoutPath}:origin`, "git@gitlab.com:acme/moved.git"]]));
      const movedContext = yield* Layer.build(layerAt(storePath).pipe(Layer.provide(remoteUrlsGitLayer)));
      const movedState = yield* Context.get(movedContext, WorkspaceRegistry).state;

      assert.strictEqual(
        findWorkspaceIssueTrackerBinding(movedState, change.workspace.config.id)?.repository,
        "acme/moved",
      );
    }).pipe(Effect.provide(RemoteUrls.layer)),
  );

  it.effect("persists a repository derived by a failed re-bind", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-workspace-registry-failed-rebind-" });
      const storePath = path.join(root, "control.db");
      const firstCheckout = yield* makeCheckout(root, "first");
      const secondCheckout = yield* makeCheckout(root, "second");
      const remotes = yield* RemoteUrls;
      yield* Ref.set(
        remotes,
        new Map([
          [`${firstCheckout}:origin`, "git@github.com:acme/old.git"],
          [`${secondCheckout}:origin`, "git@github.com:acme/new.git"],
        ]),
      );
      const initialContext = yield* Layer.build(layerAt(storePath).pipe(Layer.provide(remoteUrlsGitLayer)));
      const management = Context.get(initialContext, WorkspaceManagement);
      const registered = yield* management.register(githubRegistration("failed re-bind", firstCheckout));
      if (registered._tag === "Failed") return assert.fail("expected registration to succeed");
      yield* Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql`UPDATE workspaces
          SET mcp_skills = '{ not json'
          WHERE id = ${registered.workspace.config.id}`,
      ).pipe(Effect.provide(controlStoreClientLayer(storePath)));

      const rebound = yield* management.rebind(registered.workspace.config.id, secondCheckout);
      if (rebound._tag !== "Failed") return assert.fail("expected re-bind to fail");
      assert.strictEqual(rebound.failure.repository, "acme/new");

      yield* Ref.set(remotes, new Map([[`${secondCheckout}:origin`, "git@gitlab.com:acme/new.git"]]));
      const restartedContext = yield* Layer.build(layerAt(storePath).pipe(Layer.provide(remoteUrlsGitLayer)));
      const state = yield* Context.get(restartedContext, WorkspaceRegistry).state;

      assert.strictEqual(
        findWorkspaceIssueTrackerBinding(state, registered.workspace.config.id)?.repository,
        "acme/new",
      );
    }).pipe(Effect.provide(RemoteUrls.layer)),
  );

  it.effect("seeds the repository fallback from a legacy workspace row", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-workspace-registry-upgrade-" });
      const storePath = path.join(root, "control.db");
      const checkoutPath = yield* makeCheckout(root, "upgrade");
      const remotes = yield* RemoteUrls;
      yield* Ref.set(remotes, new Map([[`${checkoutPath}:origin`, "git@github.com:acme/current.git"]]));
      const initialContext = yield* Layer.build(layerAt(storePath).pipe(Layer.provide(remoteUrlsGitLayer)));
      const management = Context.get(initialContext, WorkspaceManagement);
      const change = yield* management.register(githubRegistration("upgrade", checkoutPath));
      if (change._tag === "Failed") return assert.fail("expected registration to succeed");

      yield* Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql`UPDATE workspaces
          SET last_repository = NULL,
              issue_tracker = ${JSON.stringify({ type: "github", connectionId: "unbound", repo: "acme/legacy" })}
          WHERE id = ${change.workspace.config.id}`,
      ).pipe(Effect.provide(controlStoreClientLayer(storePath)));
      yield* Ref.set(remotes, new Map([[`${checkoutPath}:origin`, "git@gitlab.com:acme/current.git"]]));
      const upgradedContext = yield* Layer.build(layerAt(storePath).pipe(Layer.provide(remoteUrlsGitLayer)));
      const upgradedState = yield* Context.get(upgradedContext, WorkspaceRegistry).state;

      assert.strictEqual(
        findWorkspaceIssueTrackerBinding(upgradedState, change.workspace.config.id)?.repository,
        "acme/legacy",
      );

      yield* Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql`UPDATE workspaces
          SET issue_tracker = ${JSON.stringify({ type: "github", connectionId: "unbound" })}
          WHERE id = ${change.workspace.config.id}`,
      ).pipe(Effect.provide(controlStoreClientLayer(storePath)));
      const reloadedContext = yield* Layer.build(layerAt(storePath).pipe(Layer.provide(remoteUrlsGitLayer)));
      const reloadedState = yield* Context.get(reloadedContext, WorkspaceRegistry).state;

      assert.strictEqual(
        findWorkspaceIssueTrackerBinding(reloadedState, change.workspace.config.id)?.repository,
        "acme/legacy",
      );
    }).pipe(Effect.provide(RemoteUrls.layer)),
  );

  it.effect("reports a required remote that is not GitHub", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-workspace-registry-remote-" });
      const storePath = path.join(root, "control.db");
      const checkoutPath = yield* makeCheckout(root, "unsupported");
      const unsupportedGit = gitLayerFor(() => Effect.succeed("git@gitlab.com:colonylabs/cogwork.git"));
      const context = yield* Layer.build(layerAt(storePath).pipe(Layer.provide(unsupportedGit)));
      const management = Context.get(context, WorkspaceManagement);

      const change = yield* management.register(githubRegistration("unsupported", checkoutPath));

      if (change._tag === "Registered") return assert.fail("expected registration to fail");
      assert.include(change.failure.message, 'Remote "origin"');
      assert.include(change.failure.message, "not a supported GitHub SSH or HTTPS remote");
    }),
  );

  it.effect("rejects insecure or malformed GitHub remotes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "cogwork-workspace-registry-invalid-remote-",
      });
      const storePath = path.join(root, "control.db");
      const cases = [
        { name: "http", remoteUrl: "http://github.com/colonylabs/cogwork.git" },
        { name: "query", remoteUrl: "https://github.com/colonylabs/cogwork.git?token=secret" },
        { name: "fragment", remoteUrl: "https://github.com/colonylabs/cogwork.git#readme" },
      ] as const;
      const remotes = yield* RemoteUrls;
      const checkouts = yield* Effect.forEach(cases, ({ name }) => makeCheckout(root, name));
      yield* Ref.set(
        remotes,
        new Map(cases.map(({ remoteUrl }, index) => [`${checkouts[index]}:origin`, remoteUrl])),
      );
      const context = yield* Layer.build(layerAt(storePath).pipe(Layer.provide(remoteUrlsGitLayer)));
      const management = Context.get(context, WorkspaceManagement);
      const changes = yield* Effect.forEach(cases, ({ name }, index) =>
        management.register(githubRegistration(name, checkouts[index] ?? "")),
      );

      assert.deepStrictEqual(
        changes.map((change) => change._tag),
        ["Failed", "Failed", "Failed"],
      );
      assert.isTrue(
        changes.every(
          (change) =>
            change._tag === "Failed" &&
            change.failure.message.includes("not a supported GitHub SSH or HTTPS remote"),
        ),
      );
    }).pipe(Effect.provide(RemoteUrls.layer)),
  );

  it.effect("reports a missing required remote", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-workspace-registry-missing-" });
      const storePath = path.join(root, "control.db");
      const checkoutPath = yield* makeCheckout(root, "missing");
      const missingGit = gitLayerFor((_checkoutPath, remote) =>
        Effect.fail(
          new GitError({
            command: `git remote get-url ${remote}`,
            message: `No such remote '${remote}'`,
            retryable: true,
          }),
        ),
      );
      const context = yield* Layer.build(layerAt(storePath).pipe(Layer.provide(missingGit)));
      const management = Context.get(context, WorkspaceManagement);

      const change = yield* management.register(githubRegistration("missing", checkoutPath));

      if (change._tag === "Registered") return assert.fail("expected registration to fail");
      assert.include(change.failure.message, 'Cannot read GitHub repository from remote "origin"');
      assert.include(change.failure.message, "No such remote 'origin'");
    }),
  );
});
