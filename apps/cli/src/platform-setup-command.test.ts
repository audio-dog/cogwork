import { WorktreeFs } from "@cogwork/engine";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { worktreeFsLayer } from "./platform";

describe("worktree setup command", () => {
  layer(worktreeFsLayer.pipe(Layer.provideMerge(NodeServices.layer)))((it) => {
    it.effect("reports a failed command with its exit code and output", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const worktreeFs = yield* WorktreeFs.WorktreeFs;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-setup-command-" });

        const error = yield* Effect.flip(
          worktreeFs.runCommand(cwd, "echo installing; echo lockfile is stale >&2; exit 17"),
        );

        assert.deepStrictEqual(
          { _tag: error._tag, exitCode: error.exitCode, output: error.output },
          { _tag: "WorktreeFsError", exitCode: 17, output: "installing\nlockfile is stale\n" },
        );
      }).pipe(Effect.scoped),
    );
  });
});
