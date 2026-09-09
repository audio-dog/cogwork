import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as MutableRef from "effect/MutableRef";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
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

interface ResolverProbeService {
  readonly commands: MutableRef.MutableRef<ReadonlyArray<ChildProcess.Command>>;
  readonly messages: MutableRef.MutableRef<ReadonlyArray<unknown>>;
}

class ResolverProbe extends Context.Service<ResolverProbe, ResolverProbeService>()(
  "@cogwork/desktop/main/desktop-environment.test/ResolverProbe",
) {
  static readonly layer = Layer.sync(ResolverProbe, () =>
    ResolverProbe.of({
      commands: MutableRef.make<ReadonlyArray<ChildProcess.Command>>([]),
      messages: MutableRef.make<ReadonlyArray<unknown>>([]),
    }),
  );
}

type Spawn = ChildProcessSpawner.ChildProcessSpawner["Service"]["spawn"];

const spawnerLayer = (spawn: Spawn) =>
  Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.map(ResolverProbe, (probe) =>
      ChildProcessSpawner.make((command) => {
        MutableRef.update(probe.commands, (commands) => [...commands, command]);
        return spawn(command);
      }),
    ),
  );

const loggerLayer = Layer.unwrap(
  Effect.map(ResolverProbe, (probe) =>
    Logger.layer(
      [Logger.make(({ message }) => MutableRef.update(probe.messages, (messages) => [...messages, message]))],
      { mergeWithExisting: false },
    ),
  ),
);

const testLayer = (spawn: Spawn) =>
  Layer.merge(spawnerLayer(spawn), loggerLayer).pipe(Layer.provideMerge(ResolverProbe.layer));

const inheritedLinuxEnvironment = { PATH: "/usr/bin:/bin", SHELL: "/bin/bash" };

const fallbackCases: ReadonlyArray<{ readonly name: string; readonly spawn: Spawn }> = [
  {
    name: "fails to spawn",
    spawn: () =>
      Effect.fail(
        PlatformError.systemError({
          _tag: "PermissionDenied",
          module: "ChildProcess",
          method: "spawn",
          pathOrDescriptor: "/bin/bash",
        }),
      ),
  },
  { name: "exits unsuccessfully", spawn: () => Effect.succeed(processHandle("", 1)) },
  { name: "prints no PATH", spawn: () => Effect.succeed(processHandle("startup chatter")) },
];

describe("desktop environment", () => {
  it.effect("puts login-shell PATH entries before inherited entries and removes empty duplicates", () =>
    Effect.gen(function* () {
      const probe = yield* ResolverProbe;
      const inherited = { PATH: "/usr/bin::/bin:/usr/bin", SHELL: "/bin/fish", KEEP: "yes" };
      const environment = yield* resolveDesktopEnvironment({ inherited, platform: "darwin" });

      assert.deepStrictEqual(environment, {
        PATH: "/opt/homebrew/bin:/usr/bin:/opt/bin:/bin",
        SHELL: "/bin/fish",
        KEEP: "yes",
      });
      const commands = MutableRef.get(probe.commands);
      assert.strictEqual(commands.length, 1);
      const command = commands[0];
      assert.isTrue(command !== undefined && ChildProcess.isStandardCommand(command));
      if (command === undefined || !ChildProcess.isStandardCommand(command)) return;
      assert.strictEqual(command.command, "/bin/fish");
      assert.deepStrictEqual(command.args.slice(0, 1), ["-ilc"]);
      assert.include(command.args[1] ?? "", "__COGWORK_PATH_START__");
      assert.include(command.args[1] ?? "", "__COGWORK_PATH_END__");
    }).pipe(
      Effect.provide(
        testLayer(() =>
          Effect.succeed(processHandle(outputWithPath("/opt/homebrew/bin:/usr/bin::/opt/bin"))),
        ),
      ),
    ),
  );

  it.effect("uses the platform shell when SHELL is absent", () =>
    Effect.gen(function* () {
      const probe = yield* ResolverProbe;
      yield* resolveDesktopEnvironment({ inherited: { PATH: "/usr/bin" }, platform: "linux" });

      assert.deepStrictEqual(MutableRef.get(probe.commands).map(commandExecutable), ["/bin/bash"]);
    }).pipe(
      Effect.provide(
        testLayer(() => Effect.succeed(processHandle(outputWithPath("/home/test/.local/bin:/usr/bin")))),
      ),
    ),
  );

  it.effect.each(fallbackCases)("keeps inherited PATH and logs when the login shell $name", ({ spawn }) =>
    Effect.gen(function* () {
      const probe = yield* ResolverProbe;
      const environment = yield* resolveDesktopEnvironment({
        inherited: inheritedLinuxEnvironment,
        platform: "linux",
      });

      assert.deepStrictEqual(environment, inheritedLinuxEnvironment);
      assert.isAbove(MutableRef.get(probe.messages).length, 0);
    }).pipe(Effect.provide(testLayer(spawn))),
  );

  it.effect("keeps inherited PATH and logs when the login shell exceeds the output limit", () =>
    Effect.gen(function* () {
      const probe = yield* ResolverProbe;
      const environment = yield* resolveDesktopEnvironment({
        inherited: inheritedLinuxEnvironment,
        platform: "linux",
      });

      assert.deepStrictEqual(environment, inheritedLinuxEnvironment);
      assert.isAbove(MutableRef.get(probe.messages).length, 0);
    }).pipe(Effect.provide(testLayer(() => Effect.succeed(processHandle("x".repeat(65_537)))))),
  );

  it.effect("keeps inherited PATH and logs when the login shell times out", () =>
    Effect.gen(function* () {
      const probe = yield* ResolverProbe;
      const resolving = yield* resolveDesktopEnvironment({
        inherited: inheritedLinuxEnvironment,
        platform: "linux",
      }).pipe(Effect.forkChild);
      yield* TestClock.adjust("5 seconds");
      const environment = yield* Fiber.join(resolving);

      assert.deepStrictEqual(environment, inheritedLinuxEnvironment);
      assert.isAbove(MutableRef.get(probe.messages).length, 0);
    }).pipe(Effect.provide(testLayer(() => Effect.never))),
  );

  it.effect("reads launchctl only when the macOS login shell has no PATH", () =>
    Effect.gen(function* () {
      const probe = yield* ResolverProbe;
      const inherited = { PATH: "/usr/bin:/bin", SHELL: "/bin/zsh" };
      const environment = yield* resolveDesktopEnvironment({ inherited, platform: "darwin" });

      assert.deepStrictEqual(MutableRef.get(probe.commands).map(commandExecutable), [
        "/bin/zsh",
        "/bin/launchctl",
      ]);
      assert.strictEqual(environment.PATH, "/opt/homebrew/bin:/usr/bin:/bin");
    }).pipe(
      Effect.provide(
        testLayer((command) => {
          const stdout =
            commandExecutable(command) === "/bin/launchctl" ? "/opt/homebrew/bin:/usr/bin\n" : "";
          return Effect.succeed(processHandle(stdout));
        }),
      ),
    ),
  );

  it.effect("does not read launchctl when the macOS login shell returns PATH", () =>
    Effect.gen(function* () {
      const probe = yield* ResolverProbe;
      yield* resolveDesktopEnvironment({ inherited: { PATH: "/usr/bin" }, platform: "darwin" });

      assert.deepStrictEqual(MutableRef.get(probe.commands).map(commandExecutable), ["/bin/zsh"]);
    }).pipe(
      Effect.provide(
        testLayer(() => Effect.succeed(processHandle(outputWithPath("/opt/homebrew/bin:/usr/bin")))),
      ),
    ),
  );

  it.effect("bounds the launchctl probe and preserves inherited PATH", () =>
    Effect.gen(function* () {
      const probe = yield* ResolverProbe;
      const inherited = { PATH: "/usr/bin:/bin", SHELL: "/bin/zsh" };
      const resolving = yield* resolveDesktopEnvironment({ inherited, platform: "darwin" }).pipe(
        Effect.forkChild,
      );
      yield* TestClock.adjust("2 seconds");
      const environment = yield* Fiber.join(resolving);

      assert.deepStrictEqual(environment, inherited);
      assert.deepStrictEqual(MutableRef.get(probe.commands).map(commandExecutable), [
        "/bin/zsh",
        "/bin/launchctl",
      ]);
      assert.isAbove(MutableRef.get(probe.messages).length, 1);
    }).pipe(
      Effect.provide(
        testLayer((command) =>
          commandExecutable(command) === "/bin/launchctl" ? Effect.never : Effect.succeed(processHandle()),
        ),
      ),
    ),
  );

  it.effect("returns the inherited Windows environment unchanged without spawning", () =>
    Effect.gen(function* () {
      const probe = yield* ResolverProbe;
      const inherited = { PATH: "C:\\Windows\\System32", KEEP: "yes" };
      const environment = yield* resolveDesktopEnvironment({ inherited, platform: "win32" });

      assert.strictEqual(environment, inherited);
      assert.deepStrictEqual(MutableRef.get(probe.commands), []);
    }).pipe(Effect.provide(testLayer(() => Effect.succeed(processHandle())))),
  );
});
