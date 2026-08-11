import type { IssueTrackerConfig } from "@clanker-forge/contracts";
import { Linear, Registry } from "@clanker-forge/engine";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { layer as credentialsLayer } from "./credentials";
import { loadFromDisk } from "./loader";
import { browserOpenerLayer, type LinearLoginConfig, loginKey, loginLinear, ProviderKeyError } from "./login";
import { defaultConfigHome, defaultCredentialsPath } from "./paths";

class LoginConfigError extends Schema.TaggedErrorClass<LoginConfigError>()("LoginConfigError", {
  detail: Schema.String,
}) {
  override get message() {
    return this.detail;
  }
}

const configHomeFlag = Flag.string("config-home").pipe(
  Flag.withDescription("Directory of workspace config files"),
  Flag.withDefault(defaultConfigHome),
);

const workspaceFlag = Flag.string("workspace").pipe(
  Flag.withDescription("Name of the registered workspace whose OAuth app to log in against"),
);

const credentialsFlag = Flag.string("credentials").pipe(
  Flag.withDescription("Path to the stored OAuth credential file (0600)"),
  Flag.withDefault(defaultCredentialsPath),
);

const findIssueTracker = (configHome: string, name: string) =>
  loadFromDisk(configHome).pipe(
    Effect.map((result) => Registry.buildRegistry(result).workspaces.find((w) => w.config.name === name)),
    Effect.flatMap((workspace) =>
      workspace
        ? Effect.succeed(workspace.config.issueTracker)
        : new LoginConfigError({ detail: `workspace "${name}" not found in ${configHome}` }),
    ),
  );

const resolveConfig = (
  issueTracker: IssueTrackerConfig,
): Effect.Effect<LinearLoginConfig, LoginConfigError> => {
  if (issueTracker.type !== "linear") {
    return Effect.fail(
      new LoginConfigError({ detail: `login linear needs a linear work source, not "${issueTracker.type}"` }),
    );
  }
  const clientId = issueTracker.oauth?.clientId;
  if (!clientId) {
    return Effect.fail(
      new LoginConfigError({
        detail: "missing OAuth client_id; set issueTracker.oauth.clientId in the workspace config",
      }),
    );
  }
  return Effect.succeed({
    clientId,
    redirectPort: issueTracker.oauth?.redirectPort ?? Linear.OAuth.defaultRedirectPort,
  });
};

const runLogin = (options: {
  readonly configHome: string;
  readonly workspace: string;
  readonly credentials: string;
}) =>
  Effect.gen(function* () {
    const issueTracker = yield* findIssueTracker(options.configHome, options.workspace);
    const config = yield* resolveConfig(issueTracker);
    const result = yield* loginLinear(config);
    yield* Console.log(`Logged in to Linear org "${result.organization}" as bot ${result.botUserId}.`);
  }).pipe(
    Effect.provide(
      browserOpenerLayer.pipe(
        Layer.provideMerge(credentialsLayer(options.credentials)),
        Layer.provide(FetchHttpClient.layer),
      ),
    ),
    Effect.tapError((error) => Console.error(error instanceof Error ? error.message : String(error))),
  );

const linearCommand = Command.make("linear", {
  configHome: configHomeFlag,
  workspace: workspaceFlag,
  credentials: credentialsFlag,
}).pipe(Command.withHandler(runLogin));

const providerFlag = Flag.string("provider").pipe(
  Flag.withDescription("Provider id to store a key for (anthropic, openai, google, openrouter)"),
);

const runKeyLogin = (options: { readonly provider: string; readonly credentials: string }) =>
  Effect.gen(function* () {
    yield* Console.error(`Paste your ${options.provider} API key, then press Enter and Ctrl-D:`);
    // Read from stdin, never an argv flag, so the key stays out of shell history and the process table.
    const key = yield* Effect.tryPromise({
      try: () => Array.fromAsync(process.stdin).then((chunks) => Buffer.concat(chunks).toString("utf8")),
      catch: (cause) =>
        new ProviderKeyError({
          message: `could not read the api key from stdin: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    });
    const result = yield* loginKey({ provider: options.provider, key });
    yield* Console.log(`Stored an API key for ${result.displayName}.`);
  }).pipe(
    Effect.provide(credentialsLayer(options.credentials).pipe(Layer.provide(FetchHttpClient.layer))),
    Effect.tapError((error) => Console.error(error instanceof Error ? error.message : String(error))),
  );

const keyCommand = Command.make("key", {
  provider: providerFlag,
  credentials: credentialsFlag,
}).pipe(Command.withHandler(runKeyLogin));

export const loginCommand = Command.make("login").pipe(Command.withSubcommands([linearCommand, keyCommand]));
