import { ContextFs, Git, WorktreeFs } from "@cogwork/engine";
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it, layer } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as MutableRef from "effect/MutableRef";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { contextFsLayer, gitLayer, worktreeFsLayer } from "./platform";

const interruptionGate = Latch.makeUnsafe();

const gitFixtureEnvironment = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "cogwork-test",
  GIT_AUTHOR_EMAIL: "cogwork-test@invalid",
  GIT_COMMITTER_NAME: "cogwork-test",
  GIT_COMMITTER_EMAIL: "cogwork-test@invalid",
};

const withGitFixtureEnvironment = (command: ChildProcess.Command) => {
  if (!ChildProcess.isStandardCommand(command)) return ChildProcess.setEnv(command, gitFixtureEnvironment);
  return ChildProcess.make(command.command, command.args, {
    ...command.options,
    env: { ...command.options.env, ...gitFixtureEnvironment },
    extendEnv: true,
  });
};

const testLayer: Layer.Layer<
  Git.Git | ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> = gitLayer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.effect(
        ChildProcessSpawner.ChildProcessSpawner,
        Effect.map(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
          ChildProcessSpawner.make((command) => spawner.spawn(withGitFixtureEnvironment(command))),
        ),
      ).pipe(
        Layer.provide(
          NodeChildProcessSpawner.layer.pipe(
            Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
          ),
        ),
      ),
      NodeFileSystem.layer,
      NodePath.layer,
    ),
  ),
);

const processHandle = (
  exitCode: Effect.Effect<ChildProcessSpawner.ExitCode>,
  stdout: Stream.Stream<Uint8Array> = Stream.empty,
  stderr: Stream.Stream<Uint8Array> = Stream.empty,
) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    stdin: Sink.drain,
    stdout,
    stderr,
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

const textOutput = (value: string) => Stream.make(new TextEncoder().encode(value));
const exitedProcess = (exitCode: number, stdout = "", stderr = "") =>
  processHandle(
    Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    stdout ? textOutput(stdout) : Stream.empty,
    stderr ? textOutput(stderr) : Stream.empty,
  );

const failedTargetedFetchResponses: Record<
  string,
  (oldObjectId: string) => ReturnType<typeof exitedProcess>
> = {
  fetch: () => exitedProcess(1, "", "fetch failed"),
  "for-each-ref": (oldObjectId) => exitedProcess(0, `${oldObjectId}\trefs/remotes/origin/707-fix\n`),
  "ls-remote": () => exitedProcess(0, `${"2".repeat(40)}\trefs/heads/main\n`),
  "update-ref": () => exitedProcess(1, "", "ref changed"),
};

const failedTargetedFetchProcess = (oldObjectId: string, command: string) =>
  failedTargetedFetchResponses[command.split(" ")[1] ?? ""]?.(oldObjectId) ??
  exitedProcess(1, "", "unexpected command");

const hangingSpawnerLayer = Layer.succeed(
  ChildProcessSpawner.ChildProcessSpawner,
  ChildProcessSpawner.make(() =>
    Effect.succeed(processHandle(Effect.map(interruptionGate.await, () => ChildProcessSpawner.ExitCode(0)))),
  ),
);

const platformDependenciesWithSpawner = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) =>
  Layer.mergeAll(
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    FileSystem.layerNoop({}),
    Path.layer,
  );

const gitLayerWithSpawner = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) =>
  gitLayer.pipe(Layer.provide(platformDependenciesWithSpawner(spawner)));

class GitCommands extends Context.Service<GitCommands, Ref.Ref<ReadonlyArray<string>>>()(
  "@cogwork/cli/platform.test/GitCommands",
) {
  static readonly layer = Layer.effect(GitCommands, Ref.make<ReadonlyArray<string>>([]));
}

interface GitLogProbeService {
  readonly capture: (entry: unknown) => void;
  readonly entries: Effect.Effect<ReadonlyArray<unknown>>;
}

class GitLogProbe extends Context.Service<GitLogProbe, GitLogProbeService>()(
  "@cogwork/cli/platform.test/GitLogProbe",
) {
  static readonly layer = Layer.sync(GitLogProbe, () => {
    const entries = MutableRef.make<ReadonlyArray<unknown>>([]);
    return {
      capture: (entry) => MutableRef.update(entries, (current) => [...current, entry]),
      entries: Effect.sync(() => MutableRef.get(entries)),
    };
  });
  static readonly captureLayer = Logger.layer([
    Effect.map(GitLogProbe, (probe) => Logger.make<unknown, void>(({ message }) => probe.capture(message))),
  ]).pipe(Layer.provideMerge(GitLogProbe.layer));
}

const recordedSpawnerLayer = (handleFor: (command: string) => ChildProcessSpawner.ChildProcessHandle) =>
  Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.map(GitCommands, (commands) =>
      ChildProcessSpawner.make((command) => {
        const text = commandText(command);
        return Ref.update(commands, (current) => [...current, text]).pipe(Effect.map(() => handleFor(text)));
      }),
    ),
  ).pipe(Layer.provideMerge(GitCommands.layer));

const interruptedGitLayer = () =>
  gitLayer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        recordedSpawnerLayer((text) =>
          processHandle(
            text.endsWith(" --abort")
              ? Effect.succeed(ChildProcessSpawner.ExitCode(0))
              : Effect.sleep("1 hour").pipe(Effect.map(() => ChildProcessSpawner.ExitCode(0))),
          ),
        ),
        FileSystem.layerNoop({}),
        Path.layer,
      ),
    ),
  );

const hangingWorktreeFsLayer = worktreeFsLayer.pipe(
  Layer.provide(Layer.mergeAll(hangingSpawnerLayer, FileSystem.layerNoop({}), Path.layer)),
);

const worktreeFsLayerWithSpawner = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) =>
  worktreeFsLayer.pipe(Layer.provide(platformDependenciesWithSpawner(spawner)));

const setupEnvironmentLayer = worktreeFsLayerWithSpawner(
  ChildProcessSpawner.make((command) => {
    if (!ChildProcess.isStandardCommand(command)) return Effect.die("unsupported command");
    assert.deepStrictEqual(command.options.env, { CI: "true" });
    assert.isTrue(command.options.extendEnv);
    return Effect.succeed(exitedProcess(0));
  }),
);

const setupCommandFailures: ReadonlyArray<{
  readonly command: string;
  readonly exitCode: number;
  readonly expectedMessage: string;
  readonly stderr?: string;
  readonly stdout?: string;
}> = [
  {
    command: "fail-with-stderr",
    exitCode: 1,
    expectedMessage: "stderr diagnostic",
    stderr: "  stderr diagnostic  \n",
    stdout: "stdout diagnostic\n",
  },
  {
    command: "fail-with-stdout",
    exitCode: 1,
    expectedMessage: "stdout diagnostic",
    stdout: "  stdout diagnostic  \n",
  },
  { command: "fail-silently", exitCode: 17, expectedMessage: "exited with code 17" },
];

const setupFailureLayer = worktreeFsLayerWithSpawner(
  ChildProcessSpawner.make((command) => {
    if (!ChildProcess.isStandardCommand(command)) return Effect.die("unsupported command");
    const failure = setupCommandFailures.find(({ command: expected }) => command.command === expected);
    if (!failure) return Effect.die(`unexpected command: ${command.command}`);
    return Effect.succeed(exitedProcess(failure.exitCode, failure.stdout, failure.stderr));
  }),
);

const denied = (method: string, target: string) =>
  PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method,
    pathOrDescriptor: target,
  });

const executeFixtureCommand = Effect.fn("test.executeFixtureCommand")(function* (
  cwd: string,
  script: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const exitCode = yield* spawner.exitCode(
    ChildProcess.make(script, { cwd, shell: true, env: gitFixtureEnvironment }),
  );
  if (exitCode === 0) return;
  return yield* Effect.die(new Error(`fixture failed (${exitCode}) in ${cwd}: ${script}`));
});

const shellArguments = (fixtureRoot: string, cwdOrScript: string, script?: string) => {
  if (script === undefined) return { cwd: fixtureRoot, script: cwdOrScript };
  return { cwd: cwdOrScript, script };
};

const shell = Effect.fn("test.shell")(function* (fixtureRoot: string, cwdOrScript: string, command?: string) {
  const { cwd, script } = shellArguments(fixtureRoot, cwdOrScript, command);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const topLevel = yield* spawner.string(
    ChildProcess.make("git rev-parse --show-toplevel", { cwd, shell: true, env: gitFixtureEnvironment }),
  );
  const repositoryRoot = topLevel.trim();
  if (!repositoryRoot)
    return yield* Effect.die(new Error(`fixture working directory ${cwd} is not in a repository`));

  const [realFixtureRoot, realRepositoryRoot] = yield* Effect.all([
    fs.realPath(fixtureRoot),
    fs.realPath(repositoryRoot),
  ]);
  const relative = path.relative(realFixtureRoot, realRepositoryRoot);
  if (relative !== "" && (relative.startsWith("..") || path.isAbsolute(relative)))
    return yield* Effect.die(
      new Error(`fixture repository ${realRepositoryRoot} is outside fixture root ${realFixtureRoot}`),
    );

  return yield* executeFixtureCommand(cwd, script);
});

describe("real git fixture confinement", () => {
  it.effect("rejects a repository outside the fixture root before running its script", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixtureRoot = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-git-fixture-" });
      const outsideRoot = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-git-outside-" });
      const sentinel = path.join(outsideRoot, "escaped");

      yield* executeFixtureCommand(fixtureRoot, "git init -q");
      yield* executeFixtureCommand(outsideRoot, "git init -q");

      const cause = yield* Effect.flip(
        shell(fixtureRoot, outsideRoot, `touch ${sentinel}`).pipe(Effect.sandbox),
      );

      assert.include(Cause.pretty(cause), "outside fixture root");
      assert.isFalse(yield* fs.exists(sentinel));
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
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
        assert.isTrue(error.retryable);
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
      const commands = yield* GitCommands;
      const git = yield* Git.Git;
      const fiber = yield* Effect.forkChild(git.rebase("/repo", "origin", "main"));

      yield* TestClock.adjust("1 minute");
      yield* Fiber.interrupt(fiber);

      assert.deepStrictEqual(yield* Ref.get(commands), ["git rebase origin/main main", "git rebase --abort"]);
    }).pipe(Effect.provide(interruptedGitLayer())),
  );
});

describe("git fetch", () => {
  it.effect("fetches only selected remote branches", () =>
    Effect.gen(function* () {
      const git = yield* Git.Git;
      const commands = yield* GitCommands;

      yield* git.fetch("/repo", "origin", { branches: ["main", "707-fix"] });

      assert.deepStrictEqual(yield* Ref.get(commands), [
        "git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main +refs/heads/707-fix:refs/remotes/origin/707-fix",
      ]);
    }).pipe(
      Effect.provide(
        gitLayer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              recordedSpawnerLayer(() => exitedProcess(0)),
              FileSystem.layerNoop({}),
              Path.layer,
            ),
          ),
        ),
      ),
    ),
  );

  it.effect("reports a missing branch when compare-and-swap cleanup loses a race", () => {
    const oldObjectId = "1".repeat(40);
    return Effect.gen(function* () {
      const git = yield* Git.Git;
      const commands = yield* GitCommands;

      const error = yield* Effect.flip(git.fetch("/repo", "origin", { branches: ["main", "707-fix"] }));

      assert.deepStrictEqual(error.missingBranches, ["707-fix"]);
      assert.deepStrictEqual(yield* Ref.get(commands), [
        "git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main +refs/heads/707-fix:refs/remotes/origin/707-fix",
        "git for-each-ref --format=%(objectname)%09%(refname) refs/remotes/origin/main refs/remotes/origin/707-fix",
        "git ls-remote --heads origin refs/heads/main refs/heads/707-fix",
        `git update-ref -d refs/remotes/origin/707-fix ${oldObjectId}`,
      ]);
    }).pipe(
      Effect.provide(
        gitLayer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              recordedSpawnerLayer((command) => failedTargetedFetchProcess(oldObjectId, command)),
              FileSystem.layerNoop({}),
              Path.layer,
            ),
          ),
        ),
      ),
    );
  });

  it.effect("does not update tracking refs when every selected branch exists", () =>
    Effect.gen(function* () {
      const git = yield* Git.Git;
      const commands = yield* GitCommands;

      const error = yield* Effect.flip(git.fetch("/repo", "origin", { branches: ["main", "707-fix"] }));

      assert.strictEqual(error.missingBranches, undefined);
      assert.deepStrictEqual(yield* Ref.get(commands), [
        "git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main +refs/heads/707-fix:refs/remotes/origin/707-fix",
        "git for-each-ref --format=%(objectname)%09%(refname) refs/remotes/origin/main refs/remotes/origin/707-fix",
        "git ls-remote --heads origin refs/heads/main refs/heads/707-fix",
      ]);
    }).pipe(
      Effect.provide(
        gitLayer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              recordedSpawnerLayer((command) =>
                command.startsWith("git fetch")
                  ? exitedProcess(1, "", "fetch failed")
                  : exitedProcess(
                      0,
                      `${"1".repeat(40)}\trefs/heads/main\n${"2".repeat(40)}\trefs/heads/707-fix\n`,
                    ),
              ),
              FileSystem.layerNoop({}),
              Path.layer,
            ),
          ),
        ),
      ),
    ),
  );
});

describe("git configuration scope", () => {
  it.effect("reads remote URLs only from the checkout configuration", () =>
    Effect.gen(function* () {
      const git = yield* Git.Git;

      assert.strictEqual(yield* git.remoteUrl("/repo", "origin"), "git@github.com:acme/repo.git");
      assert.deepStrictEqual(yield* Ref.get(yield* GitCommands), [
        "git config --local --get remote.origin.url",
      ]);
    }).pipe(
      Effect.provide(
        gitLayer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              recordedSpawnerLayer(() => exitedProcess(0, "git@github.com:acme/repo.git\n")),
              FileSystem.layerNoop({}),
              Path.layer,
            ),
          ),
        ),
      ),
    ),
  );
});

describe("git divergence", () => {
  it.effect("compares a remote head with a remote base from the repository checkout", () =>
    Effect.gen(function* () {
      const git = yield* Git.Git;

      assert.deepStrictEqual(
        yield* git.divergence("/repo", "origin", "main", {
          branch: "696-fix-the-gate",
          remote: "origin",
        }),
        { ahead: 2, behind: 1 },
      );
      assert.deepStrictEqual(yield* Ref.get(yield* GitCommands), [
        "git rev-list --left-right --count origin/main...origin/696-fix-the-gate",
      ]);
    }).pipe(
      Effect.provide(
        gitLayer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              recordedSpawnerLayer(() => exitedProcess(0, "1\t2\n")),
              FileSystem.layerNoop({}),
              Path.layer,
            ),
          ),
        ),
      ),
    ),
  );
});

describe("worktree setup commands", () => {
  it.layer(setupEnvironmentLayer)((it) => {
    it.effect("marks the command as CI while retaining the host environment", () =>
      Effect.gen(function* () {
        const fs = yield* WorktreeFs.WorktreeFs;
        yield* fs.runCommand("/repo", "pnpm install");
      }),
    );
  });

  layer(setupFailureLayer)((it) => {
    it.effect.each(setupCommandFailures)(
      "reports $expectedMessage when $command fails",
      ({ command, expectedMessage }) =>
        Effect.gen(function* () {
          const fs = yield* WorktreeFs.WorktreeFs;
          const error = yield* Effect.flip(fs.runCommand("/repo", command));

          assert.strictEqual(error.message, expectedMessage);
        }),
    );
  });
});

describe("platform read failures", () => {
  it.effect("keeps a stat permission failure typed", () =>
    Effect.gen(function* () {
      const fs = yield* WorktreeFs.WorktreeFs;
      const error = yield* Effect.flip(fs.stat("/private/repo"));

      assert.strictEqual(error._tag, "WorktreeFsError");
      assert.strictEqual(error.operation, "stat /private/repo");
    }).pipe(
      Effect.provide(
        worktreeFsLayer.pipe(
          Layer.provide(
            Layer.mergeAll(
              hangingSpawnerLayer,
              FileSystem.layerNoop({ stat: (target) => Effect.fail(denied("stat", target)) }),
              Path.layer,
            ),
          ),
        ),
      ),
    ),
  );

  it.effect("keeps a file-read permission failure typed", () =>
    Effect.gen(function* () {
      const fs = yield* ContextFs.ContextFs;
      const error = yield* Effect.flip(fs.readFile("/private/AGENTS.md"));

      assert.strictEqual(error._tag, "ContextFsError");
      assert.strictEqual(error.operation, "read /private/AGENTS.md");
    }).pipe(
      Effect.provide(
        contextFsLayer.pipe(
          Layer.provide(
            Layer.mergeAll(
              FileSystem.layerNoop({
                readFileString: (target) => Effect.fail(denied("readFileString", target)),
              }),
              Path.layer,
            ),
          ),
        ),
      ),
    ),
  );

  it.effect("keeps an existence-check permission failure typed", () =>
    Effect.gen(function* () {
      const git = yield* Git.Git;
      const error = yield* Effect.flip(git.operationInProgress("/private/repo"));

      assert.strictEqual(error._tag, "GitError");
      assert.strictEqual(error.command, "git rev-parse --git-path MERGE_HEAD");
    }).pipe(
      Effect.provide(
        gitLayer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(
                ChildProcessSpawner.ChildProcessSpawner,
                ChildProcessSpawner.make(() =>
                  Effect.succeed(
                    processHandle(
                      Effect.succeed(ChildProcessSpawner.ExitCode(0)),
                      Stream.make(new TextEncoder().encode(".git/MERGE_HEAD\n")),
                    ),
                  ),
                ),
              ),
              FileSystem.layerNoop({ exists: (target) => Effect.fail(denied("exists", target)) }),
              Path.layer,
            ),
          ),
        ),
      ),
    ),
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

  it.effect("returns live entries when pruning stale registrations fails", () =>
    Effect.gen(function* () {
      const git = yield* Git.Git;
      const entries = yield* git.listWorktrees("/repo");

      assert.deepStrictEqual(entries, [{ path: "/repo", branch: "main" }]);
      assert.deepStrictEqual(yield* Ref.get(yield* GitCommands), [
        "git worktree list --porcelain -z",
        "git worktree prune",
      ]);
    }).pipe(
      Effect.provide(
        gitLayer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              recordedSpawnerLayer((text) => {
                const isPrune = text === "git worktree prune";
                const stdout = isPrune
                  ? Stream.empty
                  : Stream.make(
                      new TextEncoder().encode(
                        [
                          "worktree /repo\0branch refs/heads/main",
                          "worktree /repo.worktrees/277-stale\0branch refs/heads/277-stale\0prunable stale",
                        ].join("\0\0"),
                      ),
                    );
                return processHandle(Effect.succeed(ChildProcessSpawner.ExitCode(isPrune ? 1 : 0)), stdout);
              }),
              FileSystem.layerNoop({}),
              Path.layer,
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
              recordedSpawnerLayer((text) => {
                const exitCode = text.includes(" worktree remove ") ? 1 : 0;
                return processHandle(Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)));
              }),
              FileSystem.layerNoop({}),
              Path.layer,
            ),
          ),
        ),
      ),
    ),
  );

  it.effect("logs a completed removal when the following prune fails", () =>
    Effect.gen(function* () {
      const git = yield* Git.Git;
      const logs = yield* GitLogProbe;
      yield* git.removeWorktree("/repo", "/repo.worktrees/277-stale", true);

      assert.deepStrictEqual(yield* logs.entries, [
        ["removed Git worktree", { worktreePath: "/repo.worktrees/277-stale", force: true }],
      ]);
      assert.deepStrictEqual(yield* Ref.get(yield* GitCommands), [
        "git worktree remove --force /repo.worktrees/277-stale",
        "git worktree prune",
      ]);
    }).pipe(
      Effect.provide(
        Layer.merge(
          gitLayer.pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                recordedSpawnerLayer((text) => exitedProcess(text === "git worktree prune" ? 1 : 0)),
                FileSystem.layerNoop({}),
                Path.layer,
              ),
            ),
          ),
          GitLogProbe.captureLayer,
        ),
      ),
    ),
  );
});

const fixture = Effect.fn("test.fixture")(function* (branch: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-git-" });
  const remote = path.join(root, "remote.git");
  const checkout = path.join(root, "checkout");
  const peer = path.join(root, "peer");

  yield* executeFixtureCommand(root, `git init -q --bare ${remote}`);
  yield* executeFixtureCommand(root, `git -c init.defaultBranch=main clone -q ${remote} checkout`);
  yield* shell(
    root,
    checkout,
    "git checkout -q -b main && echo base > base.txt && git add -A && git commit -qm base && git push -q -u origin main",
  );
  yield* shell(
    root,
    checkout,
    `git worktree add -q -B ${branch} ${path.join(root, "wt")} origin/main && cd ${path.join(root, "wt")} && echo work > work.txt && git add -A && git commit -qm work && git push -q origin ${branch}`,
  );
  yield* executeFixtureCommand(root, `git clone -q ${remote} peer`);

  return { root, checkout, worktree: path.join(root, "wt"), peer, branch };
});

const conflictedFixture = Effect.fn("test.conflictedFixture")(function* (branch: string) {
  const state = yield* fixture(branch);
  yield* shell(
    state.root,
    state.worktree,
    "echo base > shared.txt && git add -A && git commit -qm shared && git push -q origin HEAD",
  );
  yield* shell(
    state.root,
    state.peer,
    `git fetch -q origin && git checkout -q -B ${branch} origin/${branch} && echo theirs > shared.txt && git add -A && git commit -qm theirs && git push -q origin HEAD`,
  );
  yield* shell(
    state.root,
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

// Each test builds its own throwaway repository, so the only thing they share is wall clock
// time spent waiting on real git subprocesses. Overlap that wait. Overlapping it is also why
// these tests need their own ceiling: five fixtures competing for the same git stretch each one
// past the 5s default, and a test here is slow because it queued, not because it hung.
describe.concurrent("gitLayer against a real repository", { timeout: 20_000 }, () => {
  layer(testLayer)((it) => {
    it.effect("returns the configured remote before insteadOf rewriting", () =>
      Effect.gen(function* () {
        const git = yield* Git.Git;
        const { root, checkout } = yield* fixture("452-configured-remote");

        yield* shell(
          root,
          checkout,
          "git remote set-url origin https://github.com/colonylabs/cogwork.git && git config url.git@github.com-work:.insteadOf https://github.com/",
        );

        assert.strictEqual(
          yield* git.remoteUrl(checkout, "origin"),
          "https://github.com/colonylabs/cogwork.git",
        );
      }).pipe(Effect.scoped),
    );

    it.effect("keeps identity out of the fixture repository config", () =>
      Effect.gen(function* () {
        const { root, checkout } = yield* fixture("437-environment-identity");

        yield* shell(
          root,
          checkout,
          `test -z "$(git config --local --get-regexp '^user\\.')" && test "$(git log -1 --format='%an <%ae>')" = "cogwork-test <cogwork-test@invalid>"`,
        );
      }).pipe(Effect.scoped),
    );

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
          const { root, worktree, branch } = yield* conflictedFixture(`84-${operation}-probe`);

          yield* shell(
            root,
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
        const { root, worktree } = yield* fixture("84-paused-rebase-probe");

        yield* shell(
          root,
          worktree,
          `GIT_SEQUENCE_EDITOR=true git rebase -i --exec false HEAD~1 >/dev/null 2>&1 || { test -d "$(git rev-parse --git-path rebase-merge)" && test ! -f "$(git rev-parse --git-path REBASE_HEAD)"; }`,
        );

        assert.deepStrictEqual(yield* git.operationInProgress(worktree), {
          operation: "rebase",
          unmergedPaths: [],
        });
      }).pipe(Effect.scoped),
    );

    it.effect("does not report a completed rebase with leftover REBASE_HEAD", () =>
      Effect.gen(function* () {
        const git = yield* Git.Git;
        const { worktree, branch } = yield* conflictedFixture("434-completed-rebase-probe");

        yield* shell(
          worktree,
          `git rebase origin/${branch} >/dev/null 2>&1 || test -f "$(git rev-parse --git-path REBASE_HEAD)"`,
        );
        yield* shell(
          worktree,
          `echo resolved > shared.txt && git add shared.txt && GIT_EDITOR=true git rebase --continue >/dev/null && test -f "$(git rev-parse --git-path REBASE_HEAD)"`,
        );

        assert.isNull(yield* git.operationInProgress(worktree));
      }).pipe(Effect.scoped),
    );

    it.effect("does not report an aborted rebase", () =>
      Effect.gen(function* () {
        const git = yield* Git.Git;
        const { worktree, branch } = yield* conflictedFixture("434-aborted-rebase-probe");

        yield* shell(
          worktree,
          `git rebase origin/${branch} >/dev/null 2>&1 || test -f "$(git rev-parse --git-path REBASE_HEAD)"`,
        );
        yield* shell(worktree, "git rebase --abort");

        assert.isNull(yield* git.operationInProgress(worktree));
      }).pipe(Effect.scoped),
    );

    it.effect("does not report git am as a rebase", () =>
      Effect.gen(function* () {
        const git = yield* Git.Git;
        const { root, worktree } = yield* fixture("84-git-am-probe");

        yield* shell(
          root,
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
      const { root, checkout, peer, branch } = yield* fixture("84-diverged-branch");

      yield* shell(root, peer, `git push -q origin --delete ${branch}`);
      assert.isTrue(yield* git.remoteBranchExists(checkout, "origin", branch));

      yield* git.fetch(checkout, "origin");

      assert.isFalse(yield* git.remoteBranchExists(checkout, "origin", branch));
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("clears a confirmed missing branch after a targeted fetch fails", () =>
    Effect.gen(function* () {
      const git = yield* Git.Git;
      const { root, checkout, peer, branch } = yield* fixture("707-targeted-fetch-delete");

      yield* shell(root, peer, `git push -q origin --delete ${branch}`);
      assert.isTrue(yield* git.remoteBranchExists(checkout, "origin", branch));

      yield* Effect.flip(git.fetch(checkout, "origin", { branches: ["main", branch] }));

      assert.isFalse(yield* git.remoteBranchExists(checkout, "origin", branch));
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("measures divergence against the fetched remote and replays local commits", () =>
    Effect.gen(function* () {
      const git = yield* Git.Git;
      const { root, worktree, peer, branch } = yield* fixture("84-diverged-branch");

      yield* shell(
        root,
        peer,
        `git checkout -q -b ${branch} origin/${branch} && echo one > one.txt && git add -A && git commit -qm one && echo two > two.txt && git add -A && git commit -qm two && git push -q origin ${branch}`,
      );
      yield* shell(root, worktree, "echo ours > ours.txt && git add -A && git commit -qm ours");
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

  it.effect("measures a prepared head against a different base branch", () =>
    Effect.gen(function* () {
      const git = yield* Git.Git;
      const { worktree, branch } = yield* fixture("474-ready-for-pr");

      assert.deepStrictEqual(yield* git.divergence(worktree, "origin", "main", { branch }), {
        ahead: 1,
        behind: 0,
      });
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("leaves the branch where it was when a rebase conflicts", () =>
    Effect.gen(function* () {
      const git = yield* Git.Git;
      const { root, worktree, peer, branch } = yield* fixture("84-diverged-branch");

      yield* shell(
        root,
        peer,
        `git checkout -q -b ${branch} origin/${branch} && echo theirs > shared.txt && git add -A && git commit -qm theirs && git push -q origin ${branch}`,
      );
      yield* shell(root, worktree, "echo ours > shared.txt && git add -A && git commit -qm ours");
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

      assert.isTrue(yield* context.directoryExists(rules));
      assert.isFalse(yield* context.directoryExists(path.join(root, "missing")));
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
