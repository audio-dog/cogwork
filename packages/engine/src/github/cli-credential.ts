import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as PlatformError from "effect/PlatformError";
import * as ChildProcess from "effect/process/ChildProcess";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { CredentialError } from "../credential-store";

const commandDeadline = "10 seconds";
const successLifetime = Duration.minutes(10);
const capacity = 1;
const outputLimit = 65_536;
const statusQuery = '.hosts["github.com"][] | select(.active == true and .state == "success") | .login';
const accountStatusQuery = (account: string) =>
  `.hosts["github.com"][] | select((.login | ascii_downcase) == ${JSON.stringify(account.toLowerCase())} and .state == "success") | .login`;

const failure = (account: string, message: string) =>
  new CredentialError({ account, message, retryable: false });

const processFailure = (account: string, error: PlatformError.PlatformError | CredentialError) => {
  if (error._tag === "CredentialError") return error;
  return failure(
    account,
    error.reason._tag === "NotFound"
      ? "GitHub CLI (`gh`) not found"
      : "GitHub CLI (`gh`) could not run. Run `gh auth login` and retry",
  );
};

const collectOutput = (account: string, stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) =>
  Stream.runFoldEffect(
    stream,
    () => Buffer.alloc(0),
    (buffer, chunk) => {
      const combined = Buffer.concat([buffer, chunk]);
      if (combined.length <= outputLimit) return Effect.succeed(combined);
      return Effect.fail(failure(account, "GitHub CLI (`gh`) output exceeds 64 KiB"));
    },
  ).pipe(Effect.map((output) => output.toString("utf8")));

const capture = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  account: string,
  args: ReadonlyArray<string>,
) =>
  Effect.scoped(
    Effect.flatMap(
      spawner.spawn(ChildProcess.make("gh", [...args], { forceKillAfter: "1 second" })),
      (handle) =>
        Effect.all(
          {
            stdout: collectOutput(account, handle.stdout),
            stderr: Stream.runDrain(handle.stderr),
            exitCode: handle.exitCode,
          },
          { concurrency: "unbounded" },
        ),
    ),
  ).pipe(
    Effect.mapError((error) => processFailure(account, error)),
    Effect.timeout(commandDeadline),
    Effect.catchTag("TimeoutError", () =>
      failure(account, `GitHub CLI (\`gh\`) timed out after ${commandDeadline}`),
    ),
  );

const requireOutput = (
  account: string,
  result: { readonly stdout: string; readonly exitCode: ChildProcessSpawner.ExitCode },
) => {
  const output = result.stdout.trim();
  if (result.exitCode === 0 && output !== "") return Effect.succeed(output);
  return Effect.fail(failure(account, "Run `gh auth login` and retry"));
};

const acquisitionLifetime = (exit: Exit.Exit<Redacted.Redacted<string>, CredentialError>) =>
  Exit.isSuccess(exit) ? successLifetime : Duration.zero;

export const makeCliCredentialSource = Effect.fn("github.cliCredential.make")(function* (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
) {
  const loadToken = Effect.fn("github.cliCredential.loadToken")(function* (account: string) {
    const result = yield* capture(spawner, account, [
      "auth",
      "token",
      "--hostname",
      "github.com",
      "--user",
      account,
    ]);
    const token = yield* requireOutput(account, result);
    return Redacted.make(token);
  });
  const load = Effect.fn("github.cliCredential.acquire")(function* (account: string) {
    const result = yield* capture(spawner, account, [
      "auth",
      "status",
      "--hostname",
      "github.com",
      "--json",
      "hosts",
      "--jq",
      accountStatusQuery(account),
    ]);
    const authenticatedAccount = yield* requireOutput(account, result);
    return yield* loadToken(authenticatedAccount);
  });
  const cache = yield* Cache.makeWith(load, { capacity, timeToLive: acquisitionLifetime });
  const acquire = (account: string) => Cache.get(cache, account);
  return {
    acquire,
    forget: (account: string) => Cache.invalidate(cache, account),
    discover: capture(spawner, "github.com", [
      "auth",
      "status",
      "--hostname",
      "github.com",
      "--active",
      "--json",
      "hosts",
      "--jq",
      statusQuery,
    ]).pipe(
      Effect.flatMap((result) => requireOutput("github.com", result)),
      Effect.flatMap(loadToken),
    ),
  };
});
