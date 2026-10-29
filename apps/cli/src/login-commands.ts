import { type ConnectionEstablishment, ConnectionFailure } from "@cogwork/contracts";
import { Linear } from "@cogwork/engine";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { layer as credentialsLayer } from "./credentials";
import { browserOpenerLayer, loginKey, loginLinear, ProviderKeyError } from "./login";
import { defaultCredentialsPath, defaultSocketPath } from "./paths";
import { clientLayer, makeDaemonClient } from "./rpc";

const clientIdFlag = Flag.string("client-id").pipe(Flag.withDescription("Linear OAuth client id"));

const redirectPortFlag = Flag.integer("redirect-port").pipe(
  Flag.withDescription("Loopback OAuth callback port"),
  Flag.withDefault(Linear.OAuth.defaultRedirectPort),
);

const socketFlag = Flag.string("socket").pipe(
  Flag.withDescription("Path to the daemon control socket"),
  Flag.withDefault(defaultSocketPath),
);

const credentialsFlag = Flag.string("credentials").pipe(
  Flag.withDescription("Path to the stored OAuth credential file (0600)"),
  Flag.withDefault(defaultCredentialsPath),
);

const runLogin = Effect.fn("login.linear")(
  (options: {
    readonly clientId: string;
    readonly redirectPort: number;
    readonly socket: string;
    readonly credentials: string;
  }) =>
    Effect.gen(function* () {
      const client = yield* makeDaemonClient();
      const connections = yield* client.GetConnections();
      const existing = connections.connections.find((item) => item.system === "linear")?.connection;
      const result = yield* loginLinear({
        clientId: options.clientId,
        redirectPort: options.redirectPort,
        expectedOrganization: existing?.account,
      });
      const establishment = {
        system: "linear",
        account: result.organization,
        source: { _tag: "Stored" },
      } satisfies ConnectionEstablishment;
      const mutation = existing
        ? client.ReconnectConnection({ establishment })
        : client.EstablishConnection({ establishment });
      yield* mutation;
      yield* Console.log(
        `Logged in to Linear org "${result.organization}" as ${result.actorUserId}; Connection established.`,
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          clientLayer(options.socket),
          browserOpenerLayer.pipe(
            Layer.provideMerge(credentialsLayer(options.credentials)),
            Layer.provide(FetchHttpClient.layer),
          ),
        ),
      ),
      Effect.tapError((error) => Console.error(error instanceof Error ? error.message : String(error))),
    ),
);

const linearCommand = Command.make("linear", {
  clientId: clientIdFlag,
  redirectPort: redirectPortFlag,
  socket: socketFlag,
  credentials: credentialsFlag,
}).pipe(Command.withHandler(runLogin));

const runSlackLogin = Effect.fn("login.slack")((options: { readonly socket: string }) =>
  Effect.gen(function* () {
    const client = yield* makeDaemonClient();
    const result = yield* client.LoginSlack();
    const connection = result.overview.connections.find((item) => item.system === "slack")?.connection;
    if (!connection) {
      return yield* new ConnectionFailure({
        operation: "login Slack",
        connectionId: null,
        message: "Slack login completed without a Connection",
      });
    }
    yield* Console.log(`Logged in to Slack team "${connection.account}"; Connection established.`);
  }).pipe(
    Effect.scoped,
    Effect.provide(clientLayer(options.socket)),
    Effect.tapError((error) => Console.error(error instanceof Error ? error.message : String(error))),
  ),
);

const slackCommand = Command.make("slack", { socket: socketFlag }).pipe(Command.withHandler(runSlackLogin));

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

export const loginCommand = Command.make("login").pipe(
  Command.withSubcommands([linearCommand, slackCommand, keyCommand]),
);
