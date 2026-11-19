import { WorkspaceConfig } from "@cogwork/contracts";
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import { gitLayer, worktreeFsLayer } from "../../apps/cli/src/platform";
import type { RegisteredWorkspace } from "../../packages/engine/src/projector";
import {
  countingLayer,
  GitInvocationCounter,
} from "../../packages/engine/src/testing/git-invocation-counting";
import { managerLayer, WorktreeManager } from "../../packages/engine/src/worktree";

const gitEnvironment = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "cogwork-measurement",
  GIT_AUTHOR_EMAIL: "cogwork-measurement@invalid",
  GIT_COMMITTER_NAME: "cogwork-measurement",
  GIT_COMMITTER_EMAIL: "cogwork-measurement@invalid",
};

const nodeDependencies = Layer.merge(NodeFileSystem.layer, NodePath.layer);
const withGitEnvironment = (command: ChildProcess.Command) => {
  if (!ChildProcess.isStandardCommand(command)) return ChildProcess.setEnv(command, gitEnvironment);
  return ChildProcess.make(command.command, command.args, {
    ...command.options,
    env: { ...command.options.env, ...gitEnvironment },
    extendEnv: true,
  });
};
const platformLayer = Layer.mergeAll(
  Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.map(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
      ChildProcessSpawner.make((command) => spawner.spawn(withGitEnvironment(command))),
    ),
  ).pipe(Layer.provide(NodeChildProcessSpawner.layer.pipe(Layer.provide(nodeDependencies)))),
  nodeDependencies,
);
const countedGitLayer = countingLayer.pipe(Layer.provide(gitLayer));
const measurementLayer = managerLayer.pipe(
  Layer.provideMerge(countedGitLayer),
  Layer.provide(worktreeFsLayer),
  Layer.provideMerge(platformLayer),
);

const executeGit = Effect.fn("GitInvocationMeasurement.executeGit")(function* (
  cwd: string,
  args: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const exitCode = yield* spawner.exitCode(ChildProcess.make("git", [...args], { cwd })).pipe(
    Effect.timeout("1 minute"),
    Effect.catchTag("TimeoutError", () => Effect.die(`git ${args.join(" ")} timed out`)),
  );
  if (exitCode === 0) return;
  return yield* Effect.die(`git ${args.join(" ")} exited with ${exitCode}`);
});

const makeFixture = Effect.fn("GitInvocationMeasurement.makeFixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-git-invocations-" });
  const root = yield* fs.realPath(tempRoot);
  const remote = path.join(root, "remote.git");
  const checkout = path.join(root, "checkout");

  yield* executeGit(root, ["init", "--quiet", "--bare", remote]);
  yield* executeGit(root, ["-c", "init.defaultBranch=main", "clone", "--quiet", remote, checkout]);
  yield* executeGit(checkout, ["checkout", "--quiet", "-b", "main"]);
  yield* fs.writeFileString(path.join(checkout, "base.txt"), "base\n");
  yield* executeGit(checkout, ["add", "--all"]);
  yield* executeGit(checkout, ["commit", "--quiet", "--message", "base"]);
  yield* executeGit(checkout, ["push", "--quiet", "--set-upstream", "origin", "main"]);

  const config = yield* Schema.decodeEffect(WorkspaceConfig)({
    id: "git-invocation-measurement",
    displayName: "git-invocation-measurement",
    checkoutPath: checkout,
    issueTracker: { type: "github" },
    worktrees: {
      root: path.join(root, "worktrees"),
      setup: [`${process.execPath} -e "require('node:fs').writeFileSync('setup-ran', '')"`],
    },
  });
  const workspace = {
    source: "count-worktree-git-invocations.ts",
    contributions: [],
    config,
  } satisfies RegisteredWorkspace;

  return workspace;
});

NodeRuntime.runMain(
  Effect.gen(function* () {
    const workspace = yield* makeFixture();
    const manager = yield* WorktreeManager;
    const counter = yield* GitInvocationCounter;
    const item = { id: "#568", title: "Count worktree git invocations" };

    yield* manager.ensure(workspace, item);
    const fresh = yield* counter.read;

    yield* counter.reset;
    yield* manager.ensure(workspace, item, { resume: true });
    const resume = yield* counter.read;

    const output = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({ fresh, resume });
    yield* Console.log(output);
  }).pipe(Effect.provide(measurementLayer), Effect.scoped),
);
