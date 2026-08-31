import { ContextFs, Git, WorktreeFs } from "@cogwork/engine";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it, layer } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { contextFsLayer, gitLayer, worktreeFsLayer } from "./platform";

const testLayer = gitLayer.pipe(Layer.provideMerge(NodeServices.layer));

const isolated = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

const processHandle = (
  exitCode: Effect.Effect<ChildProcessSpawner.ExitCode>,
  stdout: Stream.Stream<Uint8Array> = Stream.empty,
) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    stdin: Sink.drain,
    stdout,
    stderr: Stream.empty,
    all: Stream.empty,
    exitCode,
    isRunning: Effect.succeed(true),
    kill: () => Effect.void,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });

const commandText = (command: ChildProcess.Command) => {
  if (!ChildProcess.isStandardCommand(command)) return "unsupported command";
  return [command.command, ...command.args].join(" ");
};

const hangingSpawnerLayer = Layer.succeed(
  ChildProcessSpawner.ChildProcessSpawner,
  ChildProcessSpawner.make(() => Effect.succeed(processHandle(Effect.never))),
);

const gitLayerWithSpawner = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) =>
  gitLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        FileSystem.layerNoop({}),
        Path.layer,
      ),
    ),
  );

class GitCommands extends Context.Service<GitCommands, Ref.Ref<ReadonlyArray<string>>>()(
  "@cogwork/cli/platform.test/GitCommands",
) {
  static readonly layer = Layer.effect(GitCommands, Ref.make<ReadonlyArray<string>>([]));
}

const hangingWorktreeFsLayer = worktreeFsLayer.pipe(
  Layer.provide(Layer.mergeAll(hangingSpawnerLayer, FileSystem.layerNoop({}), Path.layer)),
);

const shell = Effect.fn("test.shell")(function* (cwd: string, script: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const exitCode = yield* spawner.exitCode(ChildProcess.make(script, { cwd, shell: true, env: isolated }));
  if (exitCode === 0) return;
  return yield* Effect.die(new Error(`fixture failed (${exitCode}) in ${cwd}: ${script}`));
});

describe("subprocess deadlines", () => {
  layer(
    gitLayer.pipe(Layer.provide(Layer.mergeAll(hangingSpawnerLayer, FileSystem.layerNoop({}), Path.layer))),
  )((it) => {
    it.effect("converts a git deadline into GitError", () =>
      Effect.gen(function* () {
        const git = yield* Git.Git;
        const fiber = yield* Effect.forkChild(Effect.flip(git.fetch("/repo", "origin")));

        yield* TestClock.adjust("5 minutes");
        const error = yield* Fiber.join(fiber);

        assert.strictEqual(error._tag, "GitError");
        assert.strictEqual(error.command, "git fetch --prune origin");
        assert.strictEqual(error.message, "git fetch --prune origin timed out after 5 minutes");
        assert.strictEqual(error.reason, "timeout");
      }),
    );

    it.effect("does not treat a remote check timeout as a missing branch", () =>
      Effect.gen(function* () {
        const git = yield* Git.Git;
        const fiber = yield* Effect.forkChild(Effect.flip(git.remoteBranchExists("/repo", "origin", "main")));

        yield* TestClock.adjust("5 minutes");
        const error = yield* Fiber.join(fiber);

        assert.strictEqual(error.reason, "timeout");
      }),
    );
  });

  layer(hangingWorktreeFsLayer)((it) => {
    it.effect("converts a setup command deadline into WorktreeFsError", () =>
      Effect.gen(function* () {
        const fs = yield* WorktreeFs.WorktreeFs;
        const fiber = yield* Effect.forkChild(Effect.flip(fs.runCommand("/repo", "pnpm install")));

        yield* TestClock.adjust("30 minutes");
        const error = yield* Fiber.join(fiber);

        assert.strictEqual(error._tag, "WorktreeFsError");
        assert.strictEqual(error.operation, "pnpm install");
        assert.strictEqual(error.message, "pnpm install timed out after 30 minutes");
      }),
    );
  });

  it.effect("aborts an interrupted rebase", () =>
    Effect.gen(function* () {
      const commands = yield* Ref.make<ReadonlyArray<string>>([]);
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          const text = commandText(command);
          yield* Ref.update(commands, (current) => [...current, text]);
          const exitCode = yield* text.endsWith(" --abort")
            ? Effect.succeed(ChildProcessSpawner.ExitCode(0))
            : Effect.sleep("1 hour").pipe(Effect.map(() => ChildProcessSpawner.ExitCode(0)));
          return processHandle(Effect.succeed(exitCode));
        }),
      );
      const interruptedGitLayer = gitLayerWithSpawner(spawner);
      const fiber = yield* Effect.forkChild(
        Effect.gen(function* () {
          const git = yield* Git.Git;
          yield* git.rebase("/repo", "origin", "main");
        }).pipe(Effect.provide(interruptedGitLayer)),
      );

      yield* TestClock.adjust("1 minute");
      yield* Fiber.interrupt(fiber);

      assert.deepStrictEqual(yield* Ref.get(commands), ["git rebase origin/main main", "git rebase --abort"]);
    }),
  );
});

describe("worktree porcelain", () => {
  it.effect("does not report entries marked prunable", () =>
    Effect.gen(function* () {
      const git = yield* Git.Git;
      const entries = yield* git.listWorktrees("/repo");

      assert.deepStrictEqual(entries, [
        { path: "/repo", branch: "main" },
        { path: "/repo.worktrees/278-live\nprunable-looking-path", branch: "278-live" },
      ]);
    }).pipe(
      Effect.provide(
        gitLayerWithSpawner(
          ChildProcessSpawner.make(() =>
            Effect.succeed(
              processHandle(
                Effect.succeed(ChildProcessSpawner.ExitCode(0)),
                Stream.make(
                  new TextEncoder().encode(
                    [
                      [
                        "worktree /repo",
                        "HEAD 1111111111111111111111111111111111111111",
                        "branch refs/heads/main",
                      ],
                      [
                        "worktree /repo.worktrees/277-stale",
                        "HEAD 2222222222222222222222222222222222222222",
                        "branch refs/heads/277-stale",
                        "prunable gitdir file points to non-existent location",
                      ],
                      [
                        "worktree /repo.worktrees/278-live\nprunable-looking-path",
                        "HEAD 3333333333333333333333333333333333333333",
                        "branch refs/heads/278-live",
                      ],
                    ]
                      .map((fields) => fields.join("\0"))
                      .join("\0\0"),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
});

describe("worktree removal", () => {
  it.effect("prunes after remove fails", () =>
    Effect.gen(function* () {
      const git = yield* Git.Git;
      const error = yield* Effect.flip(git.removeWorktree("/repo", "/repo.worktrees/277-stale", true));

      assert.strictEqual(error.command, "git worktree remove --force /repo.worktrees/277-stale");
      assert.deepStrictEqual(yield* Ref.get(yield* GitCommands), [
        "git worktree remove --force /repo.worktrees/277-stale",
        "git worktree prune",
      ]);
    }).pipe(
      Effect.provide(
        gitLayer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              Layer.effect(
                ChildProcessSpawner.ChildProcessSpawner,
                Effect.gen(function* () {
                  const commands = yield* GitCommands;
                  return ChildProcessSpawner.make((command) =>
                    Effect.gen(function* () {
                      const text = commandText(command);
                      yield* Ref.update(commands, (current) => [...current, text]);
                      const exitCode = text.includes(" worktree remove ") ? 1 : 0;
                      return processHandle(Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)));
                    }),
                  );
                }),
              ).pipe(Layer.provideMerge(GitCommands.layer)),
              FileSystem.layerNoop({}),
              Path.layer,
            ),
          ),
        ),
      ),
    ),
  );
});

const identity = "git config user.email agent@example.com && git config user.name agent";

const fixture = Effect.fn("test.fixture")(function* (branch: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-git-" });
  const remote = path.join(root, "remote.git");
  const checkout = path.join(root, "checkout");
  const peer = path.join(root, "peer");

  yield* shell(root, `git init -q --bare ${remote}`);
  yield* shell(root, `git -c init.defaultBranch=main clone -q ${remote} checkout`);
  yield* shell(
    checkout,
    `${identity} && git checkout -q -b main && echo base > base.txt && git add -A && git commit -qm base && git push -q -u origin main`,
  );
  yield* shell(
    checkout,
    `git worktree add -q -B ${branch} ${path.join(root, "wt")} origin/main && cd ${path.join(root, "wt")} && echo work > work.txt && git add -A && git commit -qm work && git push -q origin ${branch}`,
  );
  yield* shell(root, `git clone -q ${remote} peer`);
  yield* shell(peer, identity);

  return { checkout, worktree: path.join(root, "wt"), peer, branch };
});

const conflictedFixture = Effect.fn("test.conflictedFixture")(function* (branch: string) {
  const state = yield* fixture(branch);
  yield* shell(
    state.worktree,
    "echo base > shared.txt && git add -A && git commit -qm shared && git push -q origin HEAD",
  );
  yield* shell(
    state.peer,
    `git fetch -q origin && git checkout -q -B ${branch} origin/${branch} && echo theirs > shared.txt && git add -A && git commit -qm theirs && git push -q origin HEAD`,
  );
  yield* shell(
    state.worktree,
    "echo ours > shared.txt && git add -A && git commit -qm ours && git fetch -q origin",
  );
  return state;
});

const operationFixtures: ReadonlyArray<{
  readonly operation: Git.GitOperation;
  readonly head: string;
  readonly command: (branch: string) => string;
}> = [
  { operation: "merge", head: "MERGE_HEAD", command: (branch) => `git merge origin/${branch}` },
  { operation: "rebase", head: "REBASE_HEAD", command: (branch) => `git rebase origin/${branch}` },
  {
    operation: "cherry-pick",
    head: "CHERRY_PICK_HEAD",
    command: (branch) => `git cherry-pick origin/${branch}`,
  },
];

describe("gitLayer against a real repository", () => {
  layer(testLayer)((it) => {
    it.effect("clears a prunable registration so its worktree can be recreated", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const git = yield* Git.Git;
        const { checkout, worktree, branch } = yield* fixture("277-prunable-recreation");

        yield* fs.rename(worktree, `${worktree}-removed`);
        const entries = yield* git.listWorktrees(checkout);
        assert.deepStrictEqual(
          entries.map((entry) => entry.branch),
          ["main"],
        );

        yield* git.addWorktree({
          repoPath: checkout,
          worktreePath: worktree,
          branch,
          startPoint: "origin/main",
        });
      }).pipe(Effect.scoped),
    );

    it.effect.each(operationFixtures)(
      "reports a $operation in progress and its unmerged paths",
      ({ operation, head, command }) =>
        Effect.gen(function* () {
          const git = yield* Git.Git;
          const { worktree, branch } = yield* conflictedFixture(`84-${operation}-probe`);

          yield* shell(
            worktree,
            `${command(branch)} >/dev/null 2>&1 || test -f "$(git rev-parse --git-path ${head})"`,
          );

          assert.deepStrictEqual(yield* git.operationInProgress(worktree), {
            operation,
            unmergedPaths: ["shared.txt"],
          });
        }).pipe(Effect.scoped),
    );

    it.effect("reports a paused rebase without REBASE_HEAD", () =>
      Effect.gen(function* () {
        const git = yield* Git.Git;
        const { worktree } = yield* fixture("84-paused-rebase-probe");

        yield* shell(
          worktree,
          `GIT_SEQUENCE_EDITOR=true git rebase -i --exec false HEAD~1 >/dev/null 2>&1 || { test -d "$(git rev-parse --git-path rebase-merge)" && test ! -f "$(git rev-parse --git-path REBASE_HEAD)"; }`,
        );

        assert.deepStrictEqual(yield* git.operationInProgress(worktree), {
          operation: "rebase",
          unmergedPaths: [],
        });
      }).pipe(Effect.scoped),
    );

    it.effect("does not report git am as a rebase", () =>
      Effect.gen(function* () {
        const git = yield* Git.Git;
        const { worktree } = yield* fixture("84-git-am-probe");

        yield* shell(
          worktree,
          `echo base > shared.txt && git add -A && git commit -qm shared && echo theirs > shared.txt && git commit -qam theirs && git format-patch -1 --stdout > ../theirs.patch && git reset --hard -q HEAD~1 && echo ours > shared.txt && git commit -qam ours && git am ../theirs.patch >/dev/null 2>&1 || test -f "$(git rev-parse --git-path rebase-apply/applying)"`,
        );

        assert.isNull(yield* git.operationInProgress(worktree));
      }).pipe(Effect.scoped),
    );
  });

  it.effect("stops reporting a branch that was deleted on the remote", () =>
    Effect.gen(function* () {
      const git = yield* Git.Git;
      const { checkout, peer, branch } = yield* fixture("84-diverged-branch");

      yield* shell(peer, `git push -q origin --delete ${branch}`);
      assert.isTrue(yield* git.remoteBranchExists(checkout, "origin", branch));

      yield* git.fetch(checkout, "origin");

      assert.isFalse(yield* git.remoteBranchExists(checkout, "origin", branch));
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("measures divergence against the fetched remote and replays local commits", () =>
    Effect.gen(function* () {
      const git = yield* Git.Git;
      const { worktree, peer, branch } = yield* fixture("84-diverged-branch");

      yield* shell(
        peer,
        `git checkout -q -b ${branch} origin/${branch} && echo one > one.txt && git add -A && git commit -qm one && echo two > two.txt && git add -A && git commit -qm two && git push -q origin ${branch}`,
      );
      yield* shell(worktree, "echo ours > ours.txt && git add -A && git commit -qm ours");
      yield* git.fetch(worktree, "origin");

      assert.deepStrictEqual(yield* git.divergence(worktree, "origin", branch), {
        ahead: 1,
        behind: 2,
      });

      yield* git.rebase(worktree, "origin", branch);

      assert.deepStrictEqual(yield* git.divergence(worktree, "origin", branch), {
        ahead: 1,
        behind: 0,
      });
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("leaves the branch where it was when a rebase conflicts", () =>
    Effect.gen(function* () {
      const git = yield* Git.Git;
      const { worktree, peer, branch } = yield* fixture("84-diverged-branch");

      yield* shell(
        peer,
        `git checkout -q -b ${branch} origin/${branch} && echo theirs > shared.txt && git add -A && git commit -qm theirs && git push -q origin ${branch}`,
      );
      yield* shell(worktree, "echo ours > shared.txt && git add -A && git commit -qm ours");
      yield* git.fetch(worktree, "origin");

      const failure = yield* Effect.flip(git.rebase(worktree, "origin", branch));
      assert.strictEqual(failure._tag, "GitError");

      assert.deepStrictEqual(yield* git.divergence(worktree, "origin", branch), {
        ahead: 1,
        behind: 1,
      });
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});

const contextTestLayer = contextFsLayer.pipe(Layer.provideMerge(NodeServices.layer));

describe("contextFsLayer against a real filesystem", () => {
  it.effect("lists an Authoring tree directory and treats a missing one as empty", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const context = yield* ContextFs.ContextFs;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-context-" });
      const rules = path.join(root, "rules");
      yield* fs.makeDirectory(rules, { recursive: true });
      yield* fs.writeFileString(path.join(rules, "global.md"), "global rules");

      assert.deepStrictEqual(yield* context.readDirectory(rules), ["global.md"]);
      assert.deepStrictEqual(yield* context.readDirectory(path.join(root, "missing")), []);

      const file = path.join(root, "not-a-directory");
      yield* fs.writeFileString(file, "not a directory");
      const error = yield* Effect.flip(context.readDirectory(file));
      assert.strictEqual(error._tag, "ContextFsError");
      assert.include(error.operation, "read directory");
    }).pipe(Effect.scoped, Effect.provide(contextTestLayer)),
  );

  it.effect("reads a present file and returns null for an absent one", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const context = yield* ContextFs.ContextFs;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-context-" });
      const agents = path.join(root, "AGENTS.md");
      yield* fs.writeFileString(agents, "repo rules");

      assert.strictEqual(yield* context.readFile(agents), "repo rules");
      assert.isNull(yield* context.readFile(path.join(root, "missing.md")));
    }).pipe(Effect.scoped, Effect.provide(contextTestLayer)),
  );

  it.effect("copies a skill directory with its siblings and replaces any stale destination", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const context = yield* ContextFs.ContextFs;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-context-" });

      const source = path.join(root, "skills", "implement-agent");
      yield* fs.makeDirectory(path.join(source, "reference"), { recursive: true });
      yield* fs.writeFileString(path.join(source, "SKILL.md"), "skill body");
      yield* fs.writeFileString(path.join(source, "reference", "notes.md"), "sibling notes");

      const dest = path.join(root, "home", "skills", "implement-agent");
      yield* fs.makeDirectory(dest, { recursive: true });
      yield* fs.writeFileString(path.join(dest, "stale.md"), "left over from a prior run");

      yield* context.copyDirectory(source, dest);

      assert.strictEqual(yield* fs.readFileString(path.join(dest, "SKILL.md")), "skill body");
      assert.strictEqual(yield* fs.readFileString(path.join(dest, "reference", "notes.md")), "sibling notes");
      assert.isFalse(yield* fs.exists(path.join(dest, "stale.md")));

      yield* context.removeDirectory(dest);
      assert.isFalse(yield* fs.exists(dest));
    }).pipe(Effect.scoped, Effect.provide(contextTestLayer)),
  );
});
