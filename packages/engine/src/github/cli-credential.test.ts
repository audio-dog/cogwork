import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { makeCliCredentialSource } from "./cli-credential";

const output = (value: string) => Stream.make(new TextEncoder().encode(value));

const handle = (exitCode: number, stdout = "", stderr = "") =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    stdin: Sink.drain,
    stdout: stdout === "" ? Stream.empty : output(stdout),
    stderr: stderr === "" ? Stream.empty : output(stderr),
    all: Stream.empty,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });

const commandText = (command: ChildProcess.Command) => {
  if (!ChildProcess.isStandardCommand(command)) throw new Error("expected a standard command");
  return [command.command, ...command.args].join(" ");
};

class SpawnedCommands extends Context.Service<SpawnedCommands, Ref.Ref<ReadonlyArray<string>>>()(
  "@cogwork/engine/github/cli-credential.test/SpawnedCommands",
) {
  static readonly layer = Layer.effect(SpawnedCommands, Ref.make<ReadonlyArray<string>>([]));
}

const spawnerLayer = (
  response: (command: string, attempt: number) => ChildProcessSpawner.ChildProcessHandle,
) =>
  Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function* () {
      const commands = yield* SpawnedCommands;
      const attempts = yield* Ref.make(0);
      return ChildProcessSpawner.make((command) => {
        const text = commandText(command);
        return Ref.update(commands, (current) => [...current, text]).pipe(
          Effect.andThen(Ref.updateAndGet(attempts, (current) => current + 1)),
          Effect.map((attempt) => response(text, attempt)),
        );
      });
    }),
  ).pipe(Layer.provideMerge(SpawnedCommands.layer));

describe("GitHub CLI credential source", () => {
  it.effect("discovers the active github.com account before acquiring its token", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const commands = yield* SpawnedCommands;
      const source = yield* makeCliCredentialSource(spawner);
      const token = yield* source.discover;

      assert.strictEqual(Redacted.value(token), "gho_secret");
      assert.deepStrictEqual(yield* Ref.get(commands), [
        'gh auth status --hostname github.com --active --json hosts --jq .hosts["github.com"][] | select(.active == true and .state == "success") | .login',
        "gh auth token --hostname github.com --user octocat",
      ]);
    }).pipe(
      Effect.provide(
        spawnerLayer((command) =>
          command.includes("auth status") ? handle(0, "octocat\n") : handle(0, "gho_secret\n"),
        ),
      ),
    ),
  );

  it.effect("acquires the fixed account without consulting the active account", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const commands = yield* SpawnedCommands;
      const source = yield* makeCliCredentialSource(spawner);
      const token = yield* source.acquire("fixed-account");

      assert.strictEqual(Redacted.value(token), "fixed-token");
      assert.deepStrictEqual(yield* Ref.get(commands), [
        "gh auth token --hostname github.com --user fixed-account",
      ]);
    }).pipe(Effect.provide(spawnerLayer(() => handle(0, "fixed-token\n")))),
  );

  it.effect("does not cache a discovered token before GitHub verifies it", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const source = yield* makeCliCredentialSource(spawner);

      const stale = yield* source.discover;
      const fresh = yield* source.discover;

      assert.strictEqual(Redacted.value(stale), "token-2");
      assert.strictEqual(Redacted.value(fresh), "token-4");
    }).pipe(
      Effect.provide(
        spawnerLayer((command, attempt) =>
          command.includes("auth status") ? handle(0, "octocat\n") : handle(0, `token-${attempt}\n`),
        ),
      ),
    ),
  );

  it.effect("holds successful acquisition for ten minutes and shares concurrent work", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const source = yield* makeCliCredentialSource(spawner);
      const first = yield* Effect.all([source.acquire("octocat"), source.acquire("octocat")], {
        concurrency: "unbounded",
      });
      yield* TestClock.adjust("9 minutes");
      const held = yield* source.acquire("octocat");
      yield* TestClock.adjust("1 minute");
      const refreshed = yield* source.acquire("octocat");

      assert.deepStrictEqual([...first, held, refreshed].map(Redacted.value), [
        "token-1",
        "token-1",
        "token-1",
        "token-2",
      ]);
    }).pipe(Effect.provide(spawnerLayer((_command, attempt) => handle(0, `token-${attempt}\n`)))),
  );

  it.effect("does not hold a failed acquisition", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const source = yield* makeCliCredentialSource(spawner);

      const failure = yield* Effect.flip(source.acquire("octocat"));
      const token = yield* source.acquire("octocat");

      assert.include(failure.message, "Run `gh auth login` and retry");
      assert.strictEqual(Redacted.value(token), "fresh-token");
    }).pipe(
      Effect.provide(
        spawnerLayer((_command, attempt) =>
          attempt === 1 ? handle(1, "", "signed out") : handle(0, "fresh-token\n"),
        ),
      ),
    ),
  );

  it.effect("reports an absent GitHub CLI without exposing the process failure", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const source = yield* makeCliCredentialSource(spawner);
      const failure = yield* Effect.flip(source.acquire("octocat"));

      assert.strictEqual(failure.message, "GitHub CLI (`gh`) not found");
    }).pipe(
      Effect.provide(
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.fail(
              PlatformError.systemError({
                _tag: "NotFound",
                module: "ChildProcess",
                method: "spawn",
                description: "sensitive host detail",
              }),
            ),
          ),
        ),
      ),
    ),
  );

  it.effect("reports an empty active login with the recovery command", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const source = yield* makeCliCredentialSource(spawner);
      const failure = yield* Effect.flip(source.discover);

      assert.strictEqual(failure.message, "Run `gh auth login` and retry");
    }).pipe(Effect.provide(spawnerLayer(() => handle(0)))),
  );

  it.effect("bounds GitHub CLI output", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const source = yield* makeCliCredentialSource(spawner);
      const failure = yield* Effect.flip(source.acquire("octocat"));

      assert.strictEqual(failure.message, "GitHub CLI (`gh`) output exceeds 64 KiB");
    }).pipe(Effect.provide(spawnerLayer(() => handle(0, "x".repeat(65_537))))),
  );
});
