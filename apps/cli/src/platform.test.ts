import { ContextFs, Git } from "@cogwork/engine";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { contextFsLayer, gitLayer } from "./platform";

const testLayer = gitLayer.pipe(Layer.provideMerge(NodeServices.layer));

const isolated = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

const shell = Effect.fn("test.shell")(function* (cwd: string, script: string) {
  const spawner = yield* ChildProcessSpawner;
  const exitCode = yield* spawner.exitCode(ChildProcess.make(script, { cwd, shell: true, env: isolated }));
  if (exitCode === 0) return;
  return yield* Effect.die(new Error(`fixture failed (${exitCode}) in ${cwd}: ${script}`));
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

describe("gitLayer against a real repository", () => {
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
    }).pipe(Effect.scoped, Effect.provide(contextTestLayer)),
  );
});
