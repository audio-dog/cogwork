import {
  type ConnectionEstablishment,
  ConnectionFailure,
  ConnectionId,
  type ConnectionMutationResult,
  ConnectionSystem,
  type ConnectionSystem as ConnectionSystemType,
} from "@cogwork/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Argument from "effect/unstable/cli/Argument";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";
import { defaultSocketPath } from "./paths";
import { clientLayer, makeDaemonClient } from "./rpc";

const socketFlag = Flag.string("socket").pipe(
  Flag.withDescription("Path to the daemon control socket"),
  Flag.withDefault(defaultSocketPath),
);
const envFlag = Flag.string("env").pipe(
  Flag.withDescription("Environment variable containing the token"),
  Flag.optional,
);
const apiKeyFlag = Flag.boolean("api-key").pipe(
  Flag.withDescription("Read an API key from stdin and store it"),
);
const storedFlag = Flag.boolean("stored").pipe(
  Flag.withDescription("Use an existing stored browser-login credential"),
);
const systemArgument = Argument.string("system");
const accountArgument = Argument.string("account");
const connectionIdArgument = Argument.string("connection-id");
const decodeSystem = Schema.decodeUnknownEffect(ConnectionSystem);
const decodeConnectionId = Schema.decodeUnknownEffect(ConnectionId);

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

const sourceOf = Effect.fn("connection.source")(function* (
  options: {
    readonly env: Option.Option<string>;
    readonly apiKey: boolean;
    readonly stored: boolean;
  },
  system: ConnectionSystemType,
) {
  const selected = Number(Option.isSome(options.env)) + Number(options.apiKey) + Number(options.stored);
  if (selected !== 1) {
    return yield* new ConnectionFailure({
      operation: "parse Connection source",
      connectionId: null,
      message: "choose exactly one of --env, --api-key, or --stored",
    });
  }
  const environment = Option.getOrUndefined(options.env);
  if (environment) return { _tag: "Env", name: environment } satisfies ConnectionEstablishment["source"];
  if (options.stored && system === "linear")
    return { _tag: "Stored" } satisfies ConnectionEstablishment["source"];
  if (options.stored) {
    return yield* new ConnectionFailure({
      operation: "parse Connection source",
      connectionId: null,
      message: "--stored is available only for Linear browser login",
    });
  }
  yield* Console.error("Paste the API key, then press Enter and Ctrl-D:");
  const key = yield* Effect.tryPromise({
    try: () => Array.fromAsync(process.stdin).then((chunks) => Buffer.concat(chunks).toString("utf8").trim()),
    catch: (error) =>
      new ConnectionFailure({
        operation: "read Connection API key",
        connectionId: null,
        message: error instanceof Error ? error.message : String(error),
      }),
  });
  if (key) return { _tag: "ApiKey", key: Redacted.make(key) } satisfies ConnectionEstablishment["source"];
  return yield* new ConnectionFailure({
    operation: "read Connection API key",
    connectionId: null,
    message: "API key is empty",
  });
});

const mutate = Effect.fn("connection.mutate")(function* (options: {
  readonly socket: string;
  readonly system: string;
  readonly account: string;
  readonly env: Option.Option<string>;
  readonly apiKey: boolean;
  readonly stored: boolean;
  readonly operation: "establish" | "re-connect";
}) {
  const system = yield* decodeSystem(options.system);
  const source = yield* sourceOf(options, system);
  const client = yield* makeDaemonClient();
  const establishment = { system, account: options.account, source };
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
      apiKey: apiKeyFlag,
      stored: storedFlag,
    }).pipe(Command.withHandler((options) => runMutation({ ...options, operation: "establish" }))),
    Command.make("re-connect", {
      socket: socketFlag,
      system: systemArgument,
      account: accountArgument,
      env: envFlag,
      apiKey: apiKeyFlag,
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
