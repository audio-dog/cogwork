import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

export interface DesktopEnvironmentInput {
  readonly inherited: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
}

const loginShellTimeout = "5 seconds";
const launchctlTimeout = "2 seconds";
const processTerminateGrace = "1 second";
const outputLimit = 65_536;
const startMarker = "__COGWORK_PATH_START__";
const endMarker = "__COGWORK_PATH_END__";
const printPathCommand = [
  `printf '%s\\n' '${startMarker}'`,
  "printenv PATH || true",
  `printf '%s\\n' '${endMarker}'`,
].join("; ");

const executableName = (command: ChildProcess.StandardCommand) => command.command.split("/").at(-1);

const warnProbe = (message: string, fields = {}) => Effect.logWarning(message, fields);

const collectOutput = (stream: Stream.Stream<Uint8Array, unknown>) =>
  Stream.runFoldEffect(
    stream,
    () => Buffer.alloc(0),
    (output, chunk) => {
      if (output.length + chunk.length > outputLimit) return Effect.fail("probe output exceeds 64 KiB");
      return Effect.succeed(Buffer.concat([output, chunk]));
    },
  ).pipe(Effect.map((output) => output.toString("utf8")));

const capture = (command: ChildProcess.StandardCommand) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* Effect.scoped(
      Effect.flatMap(spawner.spawn(command), (handle) =>
        Effect.all(
          {
            stdout: collectOutput(handle.stdout),
            exitCode: handle.exitCode,
          },
          { concurrency: "unbounded" },
        ),
      ),
    );
  });

const runProbe = Effect.fn("DesktopEnvironment.runProbe")(function* (
  command: ChildProcess.StandardCommand,
  timeout: Duration.Input,
) {
  const result = yield* capture(command).pipe(Effect.timeoutOption(timeout), Effect.result);
  if (Result.isFailure(result)) {
    yield* warnProbe("Desktop PATH probe failed", {
      error: result.failure,
      executable: executableName(command),
    });
    return null;
  }
  if (Option.isNone(result.success)) {
    yield* warnProbe("Desktop PATH probe timed out", {
      executable: executableName(command),
      timeout,
    });
    return null;
  }
  if (result.success.value.exitCode !== 0) {
    yield* warnProbe("Desktop PATH probe exited unsuccessfully", {
      executable: executableName(command),
      exitCode: result.success.value.exitCode,
    });
    return null;
  }
  return result.success.value.stdout;
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

const readLoginPath = Effect.fn("DesktopEnvironment.readLoginPath")(
  function* (input: DesktopEnvironmentInput) {
    const shell = shellFor(input);
    const output = yield* runProbe(
      ChildProcess.make(shell, ["-ilc", printPathCommand], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
        killSignal: "SIGTERM",
        forceKillAfter: processTerminateGrace,
      }),
      loginShellTimeout,
    );
    if (output === null) return undefined;
    const path = extractLoginPath(output);
    if (path) return path;
    yield* warnProbe("Desktop PATH probe returned no PATH", {
      executable: shell.split("/").at(-1),
    });
    return undefined;
  },
  (effect) =>
    effect.pipe(
      Effect.annotateLogs({ component: "desktop-environment", probe: "login-shell" }),
      Effect.annotateSpans({ component: "desktop-environment", probe: "login-shell" }),
    ),
);

const readLaunchctlPath = Effect.fn("DesktopEnvironment.readLaunchctlPath")(
  function* () {
    const output = yield* runProbe(
      ChildProcess.make("/bin/launchctl", ["getenv", "PATH"], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
        killSignal: "SIGTERM",
        forceKillAfter: processTerminateGrace,
      }),
      launchctlTimeout,
    );
    const path = output?.trim();
    if (path) return path;
    if (output !== null) yield* warnProbe("Desktop PATH probe returned no PATH");
    return undefined;
  },
  (effect) =>
    effect.pipe(
      Effect.annotateLogs({ component: "desktop-environment", probe: "launchctl" }),
      Effect.annotateSpans({ component: "desktop-environment", probe: "launchctl" }),
    ),
);

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
