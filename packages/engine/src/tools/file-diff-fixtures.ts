import { assert } from "@effect/vitest";
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import type { WorktreeSandbox } from "./sandbox";

const DiffValue = Schema.Struct({ path: Schema.String, diff: Schema.String });
const decodeDiffValue = Schema.decodeUnknownEffect(DiffValue);
const fileDiffMaxBytes = 64 * 1024;
const diffTruncationMarker = "\n... diff truncated by Cogwork ...\n";
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
      Queue.offerUnsafe(calls, command);
      return result;
    });
  };
  const spawn: WorktreeSandbox["handle"]["process"]["spawn"] = (command, options) =>
    sandbox.handle.process.spawn(command, options).then((process) => ({
      ...process,
      wait: () =>
        process.wait().then((exitCode) => {
          Queue.offerUnsafe(calls, command);
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
  yield* Effect.yieldNow.pipe(Effect.repeat({ times: 9 }));
  yield* TestClock.adjust("100 millis");
  const ignoreCommand = yield* Stream.fromQueue(calls).pipe(
    Stream.filter((command) => command.startsWith("git check-ignore")),
    Stream.runHead,
  );
  if (Option.isNone(ignoreCommand)) return assert.fail("ignore check did not complete");
  yield* Effect.yieldNow.pipe(Effect.repeat({ times: 9 }));
  yield* TestClock.adjust("1 second");
  const diffCommand = yield* Stream.fromQueue(calls).pipe(
    Stream.filter((command) => command.startsWith("git diff")),
    Stream.runHead,
  );
  if (Option.isNone(diffCommand)) return assert.fail("diff did not complete");
  return [ignoreCommand.value, diffCommand.value] as const;
});

export {
  advanceUntil,
  decodeDiffValue,
  diffTruncationMarker,
  ExecCalls,
  emptyOutput,
  fileDiffMaxBytes,
  gitFixtureEnvironment,
  openSandbox,
  settleDiff,
  withExecProbe,
};
