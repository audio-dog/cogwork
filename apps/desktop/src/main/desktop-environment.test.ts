import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { resolveDesktopEnvironment } from "./desktop-environment";

const encode = new TextEncoder();

const processHandle = (stdout = "", exitCode = 0) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    stdin: Sink.drain,
    stdout: stdout === "" ? Stream.empty : Stream.make(encode.encode(stdout)),
    stderr: Stream.empty,
    all: Stream.empty,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });

const outputWithPath = (path: string) =>
  ["shell startup chatter", "__COGWORK_PATH_START__", path, "__COGWORK_PATH_END__", "more chatter"].join(
    "\n",
  );

const commandExecutable = (command: ChildProcess.Command) =>
  ChildProcess.isStandardCommand(command) ? command.command : "piped-command";

const provideSpawner = <A, E, R>(
  effect: Effect.Effect<A, E, R | ChildProcessSpawner.ChildProcessSpawner>,
  spawn: ChildProcessSpawner.ChildProcessSpawner["Service"]["spawn"],
) =>
  effect.pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make(spawn)),
  );

const captureLogs = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
  const messages: Array<unknown> = [];
  const logger = Logger.make(({ message }) => messages.push(message));
  return effect.pipe(
    Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
    Effect.map((value) => ({ value, messages })),
  );
};

describe("desktop environment", () => {
  it.effect("puts login-shell PATH entries before inherited entries and removes empty duplicates", () =>
    Effect.gen(function* () {
      const commands: Array<ChildProcess.Command> = [];
      const inherited = { PATH: "/usr/bin::/bin:/usr/bin", SHELL: "/bin/fish", KEEP: "yes" };
      const environment = yield* provideSpawner(
        resolveDesktopEnvironment({ inherited, platform: "darwin" }),
        (command) => {
          commands.push(command);
          return Effect.succeed(processHandle(outputWithPath("/opt/homebrew/bin:/usr/bin::/opt/bin")));
        },
      );

      assert.deepStrictEqual(environment, {
        PATH: "/opt/homebrew/bin:/usr/bin:/opt/bin:/bin",
        SHELL: "/bin/fish",
        KEEP: "yes",
      });
      assert.strictEqual(commands.length, 1);
      const command = commands[0];
      assert.isTrue(command !== undefined && ChildProcess.isStandardCommand(command));
      if (command === undefined || !ChildProcess.isStandardCommand(command)) return;
      assert.strictEqual(command.command, "/bin/fish");
      assert.deepStrictEqual(command.args.slice(0, 1), ["-ilc"]);
      assert.include(command.args[1] ?? "", "__COGWORK_PATH_START__");
      assert.include(command.args[1] ?? "", "__COGWORK_PATH_END__");
    }),
  );

  it.effect("uses the platform shell when SHELL is absent", () =>
    Effect.gen(function* () {
      const commands: Array<ChildProcess.Command> = [];
      yield* provideSpawner(
        resolveDesktopEnvironment({ inherited: { PATH: "/usr/bin" }, platform: "linux" }),
        (command) => {
          commands.push(command);
          return Effect.succeed(processHandle(outputWithPath("/home/test/.local/bin:/usr/bin")));
        },
      );

      assert.deepStrictEqual(commands.map(commandExecutable), ["/bin/bash"]);
    }),
  );

  it.effect("keeps inherited PATH and logs when the login shell fails", () =>
    Effect.gen(function* () {
      const inherited = { PATH: "/usr/bin:/bin", SHELL: "/bin/bash" };
      const { value, messages } = yield* captureLogs(
        provideSpawner(resolveDesktopEnvironment({ inherited, platform: "linux" }), () =>
          Effect.fail(
            PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "ChildProcess",
              method: "spawn",
              pathOrDescriptor: "/bin/bash",
            }),
          ),
        ),
      );

      assert.deepStrictEqual(value, inherited);
      assert.isAbove(messages.length, 0);
    }),
  );

  it.effect("keeps inherited PATH and logs when the login shell exits unsuccessfully", () =>
    Effect.gen(function* () {
      const inherited = { PATH: "/usr/bin:/bin", SHELL: "/bin/bash" };
      const { value, messages } = yield* captureLogs(
        provideSpawner(resolveDesktopEnvironment({ inherited, platform: "linux" }), () =>
          Effect.succeed(processHandle("", 1)),
        ),
      );

      assert.deepStrictEqual(value, inherited);
      assert.isAbove(messages.length, 0);
    }),
  );

  it.effect("keeps inherited PATH and logs when the login shell prints no PATH", () =>
    Effect.gen(function* () {
      const inherited = { PATH: "/usr/bin:/bin", SHELL: "/bin/bash" };
      const { value, messages } = yield* captureLogs(
        provideSpawner(resolveDesktopEnvironment({ inherited, platform: "linux" }), () =>
          Effect.succeed(processHandle("startup chatter")),
        ),
      );

      assert.deepStrictEqual(value, inherited);
      assert.isAbove(messages.length, 0);
    }),
  );

  it.effect("keeps inherited PATH and logs when the login shell times out", () =>
    Effect.gen(function* () {
      const inherited = { PATH: "/usr/bin:/bin", SHELL: "/bin/bash" };
      const resolving = yield* provideSpawner(
        captureLogs(resolveDesktopEnvironment({ inherited, platform: "linux" })),
        () => Effect.never,
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("5 seconds");
      const { value, messages } = yield* Fiber.join(resolving);

      assert.deepStrictEqual(value, inherited);
      assert.isAbove(messages.length, 0);
    }),
  );

  it.effect("reads launchctl only when the macOS login shell has no PATH", () =>
    Effect.gen(function* () {
      const commands: Array<string> = [];
      const inherited = { PATH: "/usr/bin:/bin", SHELL: "/bin/zsh" };
      const environment = yield* provideSpawner(
        resolveDesktopEnvironment({ inherited, platform: "darwin" }),
        (command) => {
          const executable = commandExecutable(command);
          commands.push(executable);
          const stdout = executable === "/bin/launchctl" ? "/opt/homebrew/bin:/usr/bin\n" : "";
          return Effect.succeed(processHandle(stdout));
        },
      );

      assert.deepStrictEqual(commands, ["/bin/zsh", "/bin/launchctl"]);
      assert.strictEqual(environment.PATH, "/opt/homebrew/bin:/usr/bin:/bin");
    }),
  );

  it.effect("does not read launchctl when the macOS login shell returns PATH", () =>
    Effect.gen(function* () {
      const commands: Array<string> = [];
      yield* provideSpawner(
        resolveDesktopEnvironment({ inherited: { PATH: "/usr/bin" }, platform: "darwin" }),
        (command) => {
          commands.push(commandExecutable(command));
          return Effect.succeed(processHandle(outputWithPath("/opt/homebrew/bin:/usr/bin")));
        },
      );

      assert.deepStrictEqual(commands, ["/bin/zsh"]);
    }),
  );

  it.effect("bounds the launchctl probe and preserves inherited PATH", () =>
    Effect.gen(function* () {
      const commands: Array<string> = [];
      const inherited = { PATH: "/usr/bin:/bin", SHELL: "/bin/zsh" };
      const resolving = yield* provideSpawner(
        captureLogs(resolveDesktopEnvironment({ inherited, platform: "darwin" })),
        (command) => {
          const executable = commandExecutable(command);
          commands.push(executable);
          return executable === "/bin/launchctl" ? Effect.never : Effect.succeed(processHandle());
        },
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("2 seconds");
      const { value, messages } = yield* Fiber.join(resolving);

      assert.deepStrictEqual(value, inherited);
      assert.deepStrictEqual(commands, ["/bin/zsh", "/bin/launchctl"]);
      assert.isAbove(messages.length, 1);
    }),
  );

  it.effect("returns the inherited Windows environment unchanged without spawning", () =>
    Effect.gen(function* () {
      const inherited = { PATH: "C:\\Windows\\System32", KEEP: "yes" };
      const commands: Array<ChildProcess.Command> = [];
      const environment = yield* provideSpawner(
        resolveDesktopEnvironment({ inherited, platform: "win32" }),
        (command) => {
          commands.push(command);
          return Effect.succeed(processHandle());
        },
      );

      assert.strictEqual(environment, inherited);
      assert.deepStrictEqual(commands, []);
    }),
  );
});
