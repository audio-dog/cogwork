// @effect-diagnostics-next-line nodeBuiltinImport:off
import { setImmediate as yieldImmediate } from "node:timers/promises";
import { assert } from "@effect/vitest";
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { watchWorktreeDiffs } from "./file-diff-feed";
import { writeFile } from "./owned-tools";
import { resolveBaseSha, type WorktreeSandbox } from "./sandbox";

const DiffValue = Schema.Struct({ path: Schema.String, diff: Schema.String });
const decodeDiffValue = Schema.decodeUnknownEffect(DiffValue);
const fileDiffMaxBytes = 64 * 1024;
const diffTruncationMarker = "\n... diff truncated by Cogwork ...\n";
const testProcessSignal = (signal: AbortSignal) => AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
const gitCommand = "git --literal-pathspecs";
const gitDiffCommand = `${gitCommand} diff`;
const isGitDiffCommand = (command: string) => command.startsWith(gitDiffCommand);
const isExternalDiffProbe = (command: string) => command.includes("config -z --get-regexp");
const isBatchDiffCommand = (command: string) => command.includes("--raw -z --patch");
const isGitIgnoreCommand = (command: string) => command.startsWith("git check-ignore");
const gitFixtureEnvironment = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "cogwork-test",
  GIT_AUTHOR_EMAIL: "cogwork-test@invalid",
  GIT_COMMITTER_NAME: "cogwork-test",
  GIT_COMMITTER_EMAIL: "cogwork-test@invalid",
};
const emptyOutput: AsyncIterable<string> = {
  [Symbol.asyncIterator]: () => ({
    next: () => Promise.resolve({ done: true, value: undefined }),
  }),
};

const advanceUntil = (deferred: Deferred.Deferred<void>, duration: Duration.Input) =>
  Deferred.await(deferred).pipe(Effect.raceFirst(TestClock.adjust(duration).pipe(Effect.forever)));

const yieldToHost = () => Effect.promise(() => yieldImmediate()).pipe(Effect.repeat({ times: 9 }));

const settleWhileAdvancingClock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.raceFirst(TestClock.adjust("10 millis").pipe(Effect.andThen(yieldToHost()), Effect.forever)),
  );

const coalesceOutput = (output: AsyncIterable<string>) => ({
  [Symbol.asyncIterator]: () => {
    const iterator = Array.fromAsync(output).then((chunks) => ["", chunks.join("")][Symbol.iterator]());
    return { next: () => iterator.then((chunks) => chunks.next()) };
  },
});

const recordAfterProcessConsumerResumes = (calls: Queue.Queue<string>, command: string) => {
  setImmediate(() => setImmediate(() => Queue.offerUnsafe(calls, command)));
};

const takeAllCalls = (calls: Queue.Queue<string>) => yieldToHost().pipe(Effect.andThen(Queue.takeAll(calls)));

class ExecCalls extends Context.Service<ExecCalls, Queue.Queue<string>>()(
  "@cogwork/engine/tools/file-diff-fixtures/ExecCalls",
) {
  static readonly layer = Layer.effect(ExecCalls, Queue.unbounded<string>());
}

const openSandbox = Effect.fn("file-diff-feed.test.openSandbox")(function* () {
  const handle = yield* Effect.acquireRelease(
    Effect.promise(() => localProcessSandbox({}).create({})),
    (h) => Effect.promise(() => h.destroy()),
  );
  const sandbox: WorktreeSandbox = { handle, root: handle.id };
  const init = yield* Effect.promise(() =>
    handle.process.exec("git init -q && printf 'seed\\n' > seed.txt && git add -A && git commit -q -m init", {
      env: gitFixtureEnvironment,
    }),
  );
  assert.strictEqual(init.exitCode, 0, init.stderr);
  return sandbox;
});

const withExecProbe = Effect.fn("file-diff-feed.test.withExecProbe")(function* (sandbox: WorktreeSandbox) {
  const calls = yield* ExecCalls;
  const exec: WorktreeSandbox["handle"]["process"]["exec"] = (command, options) => {
    return sandbox.handle.process.exec(command, options).then((result) => {
      recordAfterProcessConsumerResumes(calls, command);
      return result;
    });
  };
  const spawn: WorktreeSandbox["handle"]["process"]["spawn"] = (command, options) =>
    sandbox.handle.process.spawn(command, options).then((process) => ({
      ...process,
      stdout: command.includes("--raw -z --patch") ? coalesceOutput(process.stdout) : process.stdout,
      wait: () =>
        process.wait().then((exitCode) => {
          recordAfterProcessConsumerResumes(calls, command);
          return exitCode;
        }),
    }));
  return {
    ...sandbox,
    handle: {
      ...sandbox.handle,
      process: {
        ...sandbox.handle.process,
        exec,
        spawn,
      },
    },
  };
});

const settleDiff = Effect.fn("file-diff-feed.test.settleDiff")(function* (calls: Queue.Queue<string>) {
  const ignoreCommand = yield* settleWhileAdvancingClock(
    Stream.fromQueue(calls).pipe(Stream.filter(isGitIgnoreCommand), Stream.runHead),
  );
  if (Option.isNone(ignoreCommand)) return assert.fail("ignore check did not complete");
  const diffCommand = yield* settleWhileAdvancingClock(
    Stream.fromQueue(calls).pipe(Stream.filter(isGitDiffCommand), Stream.runHead),
  );
  if (Option.isNone(diffCommand)) return assert.fail("diff did not complete");
  return [ignoreCommand.value, diffCommand.value] as const;
});

const startBlockedBatch = Effect.fn("file-diff-feed.test.startBlockedBatch")(function* (
  exitOn: "SIGTERM" | "SIGKILL",
) {
  const original = yield* openSandbox();
  yield* writeFile(original, { path: "other.txt", content: "other\n" });
  const commit = yield* Effect.promise((signal) =>
    original.handle.process.exec("git add -A && git commit -q -m blocked-batch-fixture", {
      env: gitFixtureEnvironment,
      signal: testProcessSignal(signal),
    }),
  );
  assert.strictEqual(commit.exitCode, 0, commit.stderr);
  const baseSha = yield* resolveBaseSha(original);
  yield* writeFile(original, { path: "seed.txt", content: "seed changed\n" });
  yield* writeFile(original, { path: "other.txt", content: "other changed\n" });
  const started = yield* Deferred.make<void>();
  const reading = yield* Deferred.make<void>();
  const terminated = yield* Deferred.make<void>();
  const killed = yield* Deferred.make<void>();
  const exit = Promise.withResolvers<number>();
  const stdout: AsyncIterable<string> = {
    [Symbol.asyncIterator]: () => ({
      next: () => {
        Deferred.doneUnsafe(reading, Effect.void);
        return Promise.resolve({ done: true, value: undefined });
      },
    }),
  };
  const spawn: WorktreeSandbox["handle"]["process"]["spawn"] = (command, options) => {
    if (!command.includes("--raw -z --patch")) return original.handle.process.spawn(command, options);
    Deferred.doneUnsafe(started, Effect.void);
    return Promise.resolve({
      pid: 1,
      stdout,
      stderr: emptyOutput,
      stdin: {
        write: () => Promise.resolve(),
        end: () => Promise.resolve(),
      },
      wait: () => exit.promise,
      kill: (signal) => {
        if (signal === "SIGTERM") Deferred.doneUnsafe(terminated, Effect.void);
        if (signal === "SIGKILL") Deferred.doneUnsafe(killed, Effect.void);
        if (signal === exitOn) exit.resolve(signal === "SIGKILL" ? 137 : 143);
        return Promise.resolve();
      },
    });
  };
  const sandbox: WorktreeSandbox = {
    ...original,
    handle: {
      ...original.handle,
      process: { ...original.handle.process, spawn },
    },
  };
  const events = [
    { _tag: "Update", path: "seed.txt" },
    { _tag: "Update", path: "other.txt" },
  ] satisfies ReadonlyArray<FileSystem.WatchEvent>;
  const fiber = yield* watchWorktreeDiffs(sandbox, baseSha).pipe(
    Stream.runDrain,
    Effect.provide(FileSystem.layerNoop({ watch: () => Stream.fromIterable(events) })),
    Effect.forkChild,
  );
  yield* Deferred.await(started);
  yield* Deferred.await(reading);
  return { fiber, terminated, killed };
});

export {
  advanceUntil,
  coalesceOutput,
  DiffValue,
  decodeDiffValue,
  diffTruncationMarker,
  ExecCalls,
  emptyOutput,
  fileDiffMaxBytes,
  gitCommand,
  gitDiffCommand,
  gitFixtureEnvironment,
  isBatchDiffCommand,
  isExternalDiffProbe,
  isGitDiffCommand,
  isGitIgnoreCommand,
  openSandbox,
  recordAfterProcessConsumerResumes,
  settleDiff,
  settleWhileAdvancingClock,
  startBlockedBatch,
  takeAllCalls,
  testProcessSignal,
  withExecProbe,
  yieldToHost,
};
