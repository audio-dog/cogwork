import {
  type ConnectionEstablishment,
  ConnectionFailure,
  ConnectionId,
  type ConnectionMutationResult,
  ConnectionSystem,
  type ConnectionSystem as ConnectionSystemType,
} from "@cogwork/contracts";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { defaultSocketPath } from "./paths";
import { clientLayer, makeDaemonClient } from "./rpc";

const socketFlag = Flag.String("socket").pipe(
  Flag.withDescription("Path to the daemon control socket"),
  Flag.withDefault(defaultSocketPath),
);
const envFlag = Flag.String("env").pipe(
  Flag.withDescription("Environment variable containing the token"),
  Flag.optional,
);
const storedFlag = Flag.Boolean("stored").pipe(
  Flag.withDescription("Use an existing stored browser-login credential"),
);
const githubCliFlag = Flag.Boolean("github-cli").pipe(
  Flag.withDescription("Use the login saved by gh auth login"),
);
const systemArgument = Argument.String("system");
const accountArgument = Argument.String("account").pipe(Argument.optional);
const connectionIdArgument = Argument.String("connection-id");
const decodeSystem = Schema.decodeUnknownEffect(ConnectionSystem);
const decodeConnectionId = Schema.decodeUnknownEffect(ConnectionId);
const storedLoginSystems = new Set<ConnectionSystemType>(["linear", "granola"]);

type ApiKeySource = Extract<ConnectionEstablishment["source"], { readonly _tag: "ApiKey" }>;
type ConnectionSourceOptions = {
  readonly env: Option.Option<string>;
  readonly githubCli: boolean;
  readonly stored: boolean;
};

const apiKeyInputLimit = 64 * 1024;
const apiKeyInputFailure = (message: string) =>
  new ConnectionFailure({
    operation: "read Connection API key",
    connectionId: null,
    message,
  });

const slackBrowserLoginFailure = () =>
  new ConnectionFailure({
    operation: "parse Connection account",
    connectionId: null,
    message: "Slack Connections use browser sign-in; run cogwork login slack",
  });

export const formatConnectionMutation = (
  verb: "Established" | "Re-connected" | "Removed",
  result: ConnectionMutationResult,
) => {
  const warning =
    result.danglingWorkspaces.length === 0
      ? []
      : [`Warning: Workspaces left dangling: ${result.danglingWorkspaces.join(", ")}.`];
  return [`${verb} Connection.`, ...warning].join("\n");
};

export const resolveConnectionSource = Effect.fn("connection.source")(function* (
  options: ConnectionSourceOptions,
  system: ConnectionSystemType,
  readApiKey: Effect.Effect<ApiKeySource, ConnectionFailure>,
) {
  if (system === "slack") return yield* slackBrowserLoginFailure();
  const selected = [Option.isSome(options.env), options.githubCli, options.stored].filter(Boolean);
  if (selected.length > 1) {
    return yield* new ConnectionFailure({
      operation: "parse Connection source",
      connectionId: null,
      message: "Choose only one credential source: --env, --github-cli, or --stored",
    });
  }
  if (Option.isSome(options.env))
    return { _tag: "Env", name: options.env.value } satisfies ConnectionEstablishment["source"];
  if (options.githubCli && system !== "github") {
    return yield* new ConnectionFailure({
      operation: "parse Connection source",
      connectionId: null,
      message: "--github-cli is available only for GitHub Connections",
    });
  }
  if (options.githubCli) return { _tag: "GitHubCli" } satisfies ConnectionEstablishment["source"];
  if (!options.stored) return yield* readApiKey;
  if (!storedLoginSystems.has(system)) {
    return yield* new ConnectionFailure({
      operation: "parse Connection source",
      connectionId: null,
      message: "--stored is available only for browser-login Connections",
    });
  }
  return { _tag: "Stored" } satisfies ConnectionEstablishment["source"];
});

export const readApiKeyFrom = Effect.fn("connection.readApiKeyFrom")(function* (
  input: AsyncIterable<Uint8Array>,
) {
  const bytes = yield* Stream.fromAsyncIterable(input, (error) =>
    apiKeyInputFailure(error instanceof Error ? error.message : String(error)),
  ).pipe(
    Stream.runFoldEffect(
      () => Buffer.alloc(0),
      (buffer, chunk) => {
        const combined = Buffer.concat([buffer, chunk]);
        if (combined.length <= apiKeyInputLimit) return Effect.succeed(combined);
        return Effect.fail(apiKeyInputFailure("API key input exceeds 64 KiB"));
      },
    ),
  );
  const key = bytes.toString("utf8").trim();
  if (key) return { _tag: "ApiKey", key: Redacted.make(key) } satisfies ConnectionEstablishment["source"];
  return yield* apiKeyInputFailure("API key is empty");
});

const readApiKey = Effect.fn("connection.readApiKey")(function* () {
  yield* Console.error("Paste the API key, then press Enter and Ctrl-D:");
  return yield* readApiKeyFrom(process.stdin);
});

const sourceOf = (options: ConnectionSourceOptions, system: ConnectionSystemType) =>
  resolveConnectionSource(options, system, readApiKey());

export const establishmentOf = Effect.fn("connection.establishment")(function* (
  system: ConnectionSystemType,
  account: Option.Option<string>,
  source: ConnectionEstablishment["source"],
) {
  if (system === "slack") return yield* slackBrowserLoginFailure();
  if (system === "github" && Option.isSome(account)) {
    return yield* new ConnectionFailure({
      operation: "parse Connection account",
      connectionId: null,
      message: "GitHub Connections discover the account; omit the account argument",
    });
  }
  if (system === "github") return { system, source } satisfies ConnectionEstablishment;
  if (system === "granola" && source._tag === "ApiKey" && !Redacted.value(source.key).startsWith("grn_")) {
    return yield* new ConnectionFailure({
      operation: "parse Connection API key",
      connectionId: null,
      message: "Granola API keys must start with grn_",
    });
  }
  if (Option.isSome(account))
    return { system, account: account.value, source } satisfies ConnectionEstablishment;
  return yield* new ConnectionFailure({
    operation: "parse Connection account",
    connectionId: null,
    message: `${system === "linear" ? "Linear" : "Granola"} Connections require an account argument`,
  });
});

const mutate = Effect.fn("connection.mutate")(function* (options: {
  readonly socket: string;
  readonly system: string;
  readonly account: Option.Option<string>;
  readonly env: Option.Option<string>;
  readonly githubCli: boolean;
  readonly stored: boolean;
  readonly operation: "establish" | "re-connect";
}) {
  const system = yield* decodeSystem(options.system);
  const source = yield* sourceOf(options, system);
  const client = yield* makeDaemonClient();
  const establishment = yield* establishmentOf(system, options.account, source);
  const result =
    options.operation === "establish"
      ? yield* client.EstablishConnection({ establishment })
      : yield* client.ReconnectConnection({ establishment });
  yield* Console.log(
    formatConnectionMutation(options.operation === "establish" ? "Established" : "Re-connected", result),
  );
});

const runMutation = Effect.fn("connection.mutateWithLayers")(function* (
  options: Parameters<typeof mutate>[0],
) {
  return yield* mutate(options).pipe(Effect.scoped, Effect.provide(clientLayer(options.socket)));
});

const remove = Effect.fn("connection.remove")(function* (options: {
  readonly socket: string;
  readonly connectionId: string;
}) {
  const client = yield* makeDaemonClient();
  const connectionId = yield* decodeConnectionId(options.connectionId);
  const result = yield* client.RemoveConnection({ connectionId });
  yield* Console.log(formatConnectionMutation("Removed", result));
});

export const connectionCommand = Command.make("connection").pipe(
  Command.withSubcommands([
    Command.make("establish", {
      socket: socketFlag,
      system: systemArgument,
      account: accountArgument,
      env: envFlag,
      githubCli: githubCliFlag,
      stored: storedFlag,
    }).pipe(Command.withHandler((options) => runMutation({ ...options, operation: "establish" }))),
    Command.make("re-connect", {
      socket: socketFlag,
      system: systemArgument,
      account: accountArgument,
      env: envFlag,
      githubCli: githubCliFlag,
      stored: storedFlag,
    }).pipe(Command.withHandler((options) => runMutation({ ...options, operation: "re-connect" }))),
    Command.make("remove", {
      socket: socketFlag,
      connectionId: connectionIdArgument,
    }).pipe(
      Command.withHandler((options) =>
        remove(options).pipe(Effect.scoped, Effect.provide(clientLayer(options.socket))),
      ),
    ),
  ]),
);
