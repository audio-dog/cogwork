import { WorkspaceInput, WorkspaceRegistration } from "@cogwork/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, layer } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
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
          name: "second clone",
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
        }),
      );
      if (firstChange._tag === "Failed" || secondChange._tag === "Failed") {
        return assert.fail("expected valid Workspace inputs to register");
      }
      const first = firstChange.workspace;
      const second = secondChange.workspace;
      assert.notStrictEqual(first.config.name, second.config.name);
      assert.strictEqual(first.config.displayName, "first clone");
      assert.strictEqual(first.workspaceLimit, 2);
      assert.deepStrictEqual(first.config.worktrees, {
        root: path.join(root, "worktrees"),
        remote: "upstream",
        baseBranch: "trunk",
        setup: ["pnpm install"],
        linkPaths: [".env"],
      });
      assert.strictEqual(missingChange._tag, "Failed");
      assert.strictEqual(liveRegistry.failures.length, 1);

      yield* fs.writeFileString(
        path.join(firstCheckout, ".agents", "workspace.json"),
        encodeWorkspaceInput(changedWorkspaceInput),
      );
      yield* liveRegistry.refresh;
      assert.deepStrictEqual(Registry.findWorkspace(liveRegistry, "first clone")?.config.worktrees?.setup, [
        "pnpm test",
      ]);

      const reloadedContext = yield* Layer.build(Registry.layerAt(storePath));
      const reloaded = Context.get(reloadedContext, Registry.WorkspaceRegistry);

      assert.strictEqual(reloaded.workspaces.length, 2);
      assert.strictEqual(reloaded.failures.length, 1);
      assert.deepStrictEqual(reloaded.workspaces.map((workspace) => workspace.config.displayName).sort(), [
        "first clone",
        "second clone",
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
});
