import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

export interface DesktopEnvironmentInput {
  readonly inherited: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
}

type DesktopEnvironmentProbe = "login-shell" | "launchctl";

const loginShellTimeout = "5 seconds";
const launchctlTimeout = "2 seconds";
const processTerminateGrace = "1 second";
const startMarker = "__COGWORK_PATH_START__";
const endMarker = "__COGWORK_PATH_END__";
const printPathCommand = [
  `printf '%s\\n' '${startMarker}'`,
  "printenv PATH || true",
  `printf '%s\\n' '${endMarker}'`,
].join("; ");

const executableName = (command: ChildProcess.Command) =>
  ChildProcess.isStandardCommand(command) ? command.command.split("/").at(-1) : "piped-command";

const warnProbe = (probe: DesktopEnvironmentProbe, message: string, fields = {}) =>
  Effect.logWarning(message, { component: "desktop-environment", probe, ...fields });

const capture = (command: ChildProcess.Command) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* Effect.scoped(
      Effect.flatMap(spawner.spawn(command), (handle) =>
        Effect.all(
          {
            stdout: handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
            stderr: Stream.runDrain(handle.stderr),
            exitCode: handle.exitCode,
          },
          { concurrency: "unbounded" },
        ),
      ),
    );
  });

const runProbe = Effect.fn("DesktopEnvironment.runProbe")(function* (
  probe: DesktopEnvironmentProbe,
  command: ChildProcess.Command,
  timeout: Duration.Input,
) {
  const exit = yield* capture(command).pipe(Effect.timeoutOption(timeout), Effect.exit);
  if (Exit.isFailure(exit)) {
    yield* warnProbe(probe, "Desktop PATH probe failed", {
      cause: exit.cause,
      executable: executableName(command),
    });
    return null;
  }
  if (Option.isNone(exit.value)) {
    yield* warnProbe(probe, "Desktop PATH probe timed out", {
      executable: executableName(command),
      timeout,
    });
    return null;
  }
  if (exit.value.value.exitCode !== 0) {
    yield* warnProbe(probe, "Desktop PATH probe exited unsuccessfully", {
      executable: executableName(command),
      exitCode: exit.value.value.exitCode,
    });
    return null;
  }
  return exit.value.value.stdout;
});

const extractLoginPath = (output: string) => {
  const start = output.indexOf(startMarker);
  if (start === -1) return undefined;
  const valueStart = start + startMarker.length;
  const end = output.indexOf(endMarker, valueStart);
  if (end === -1) return undefined;
  const value = output
    .slice(valueStart, end)
    .replace(/^\r?\n/, "")
    .replace(/\r?\n$/, "")
    .trim();
  return value || undefined;
};

const shellFor = (input: DesktopEnvironmentInput) => {
  const configured = input.inherited.SHELL?.trim();
  if (configured) return configured;
  return input.platform === "darwin" ? "/bin/zsh" : "/bin/bash";
};

const readLoginPath = Effect.fn("DesktopEnvironment.readLoginPath")(function* (
  input: DesktopEnvironmentInput,
) {
  const shell = shellFor(input);
  const output = yield* runProbe(
    "login-shell",
    ChildProcess.make(shell, ["-ilc", printPathCommand], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      killSignal: "SIGTERM",
      forceKillAfter: processTerminateGrace,
    }),
    loginShellTimeout,
  );
  if (output === null) return undefined;
  const path = extractLoginPath(output);
  if (path) return path;
  yield* warnProbe("login-shell", "Desktop PATH probe returned no PATH", {
    executable: shell.split("/").at(-1),
  });
  return undefined;
});

const readLaunchctlPath = Effect.fn("DesktopEnvironment.readLaunchctlPath")(function* () {
  const output = yield* runProbe(
    "launchctl",
    ChildProcess.make("/bin/launchctl", ["getenv", "PATH"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      killSignal: "SIGTERM",
      forceKillAfter: processTerminateGrace,
    }),
    launchctlTimeout,
  );
  const path = output?.trim();
  if (path) return path;
  if (output !== null) yield* warnProbe("launchctl", "Desktop PATH probe returned no PATH");
  return undefined;
});

const mergePaths = (paths: ReadonlyArray<string | undefined>) => {
  const entries = paths.flatMap((path) => path?.split(":") ?? []).map((entry) => entry.trim());
  return [...new Set(entries.filter(Boolean))].join(":");
};

const withPath = (inherited: NodeJS.ProcessEnv, discovered: string | undefined) => {
  const path = mergePaths([discovered, inherited.PATH]);
  if (!path) return inherited;
  return { ...inherited, PATH: path };
};

export const resolveDesktopEnvironment = Effect.fn("DesktopEnvironment.resolve")(function* (
  input: DesktopEnvironmentInput,
) {
  if (input.platform !== "darwin" && input.platform !== "linux") return input.inherited;
  const loginPath = yield* readLoginPath(input);
  if (loginPath || input.platform === "linux") return withPath(input.inherited, loginPath);
  const launchctlPath = yield* readLaunchctlPath();
  return withPath(input.inherited, launchctlPath);
});
