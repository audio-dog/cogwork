import type { WorkSourceConfig } from "@clanker-forge/contracts";
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
import { browserOpenerLayer, type LinearLoginConfig, loginLinear } from "./login";
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

const findWorkSource = (configHome: string, name: string) =>
  loadFromDisk(configHome).pipe(
    Effect.map((result) => Registry.buildRegistry(result).workspaces.find((w) => w.config.name === name)),
    Effect.flatMap((workspace) =>
      workspace
        ? Effect.succeed(workspace.config.workSource)
        : new LoginConfigError({ detail: `workspace "${name}" not found in ${configHome}` }),
    ),
  );

const resolveConfig = (workSource: WorkSourceConfig): Effect.Effect<LinearLoginConfig, LoginConfigError> => {
  if (workSource.type !== "linear") {
    return Effect.fail(
      new LoginConfigError({ detail: `login linear needs a linear work source, not "${workSource.type}"` }),
    );
  }
  const clientId = workSource.oauth?.clientId;
  if (!clientId) {
    return Effect.fail(
      new LoginConfigError({
        detail: "missing OAuth client_id; set workSource.oauth.clientId in the workspace config",
      }),
    );
  }
  return Effect.succeed({
    clientId,
    redirectPort: workSource.oauth?.redirectPort ?? Linear.OAuth.defaultRedirectPort,
  });
};

const runLogin = (options: {
  readonly configHome: string;
  readonly workspace: string;
  readonly credentials: string;
}) =>
  Effect.gen(function* () {
    const workSource = yield* findWorkSource(options.configHome, options.workspace);
    const config = yield* resolveConfig(workSource);
    const result = yield* loginLinear(config);
    yield* Console.log(`Logged in to Linear org "${result.organization}" as bot ${result.botUserId}.`);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(credentialsLayer(options.credentials), browserOpenerLayer, FetchHttpClient.layer),
    ),
    Effect.tapError((error) => Console.error(error instanceof Error ? error.message : String(error))),
  );

const linearCommand = Command.make("linear", {
  configHome: configHomeFlag,
  workspace: workspaceFlag,
  credentials: credentialsFlag,
}).pipe(Command.withHandler(runLogin));

export const loginCommand = Command.make("login").pipe(Command.withSubcommands([linearCommand]));
