import {
  type ControlStoreFailure,
  DaemonRpcs,
  keyOf,
  parseWorkItemReference,
  type StartOverRefused,
  type WorkItemRef,
  WorkspaceId,
} from "@cogwork/contracts";
import * as Console from "effect/Console";
import * as Argument from "effect/cli/Argument";
import * as CliError from "effect/cli/CliError";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Prompt from "effect/cli/Prompt";
import * as Effect from "effect/Effect";
import * as RpcClient from "effect/rpc/RpcClient";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import * as Schema from "effect/Schema";
import { defaultSocketPath } from "./paths";
import { clientLayer } from "./rpc";
import { terminalLine } from "./terminal-text";
import { workspaceFlag } from "./workspace-commands";

interface StartOverOptions {
  readonly workspace: string;
  readonly item: string;
  readonly yes: boolean;
}

interface StartOverRequest {
  readonly item: WorkItemRef;
}

const inputError = (message: string, cause: unknown) =>
  new CliError.UserError({ cause, userMessage: terminalLine(message) });

const makeStartOverRequest = Effect.fn("startOver.makeRequest")(function* (options: StartOverOptions) {
  const workspace = yield* Schema.decodeEffect(WorkspaceId)(options.workspace).pipe(
    Effect.mapError((error) => inputError(`Invalid workspace: ${error.message}`, error)),
  );
  const item = yield* Effect.fromResult(parseWorkItemReference(workspace, options.item)).pipe(
    Effect.mapError((message) => inputError(message, message)),
  );
  return { item } satisfies StartOverRequest;
});

const questionOf = (request: StartOverRequest) =>
  terminalLine(
    `Start over ${keyOf(request.item)}? Cogwork deletes the item's coordination records and Workflow action plans.`,
  );

export const startOver = Effect.fn("startOver.confirmAndSend")(function* <EC, RC, ES, RS>(
  options: StartOverOptions,
  confirm: (question: string) => Effect.Effect<boolean, EC, RC>,
  send: (request: StartOverRequest) => Effect.Effect<void, ES, RS>,
) {
  const request = yield* makeStartOverRequest(options);
  const confirmed = options.yes || (yield* confirm(questionOf(request)));
  if (!confirmed) return yield* Console.log("Start over cancelled.");
  yield* send(request);
  yield* Console.log(
    terminalLine(`Started over ${keyOf(request.item)}. Its Triggers admit it again on the next poll.`),
  );
});

const startOverError = (error: StartOverRefused | ControlStoreFailure | RpcClientError) =>
  inputError(`Could not start over the work item: ${error.message}`, error);

const runStartOver = Effect.fn("startOver.run")(
  function* (options: StartOverOptions & { readonly socket: string }) {
    const client = yield* RpcClient.make(DaemonRpcs);
    yield* startOver(
      options,
      (message) => Prompt.Confirm({ message }),
      (request) => client.StartOver(request).pipe(Effect.mapError(startOverError)),
    );
  },
  (effect, options) => effect.pipe(Effect.scoped, Effect.provide(clientLayer(options.socket))),
);

const socketFlag = Flag.String("socket").pipe(
  Flag.withDescription("Path to the daemon control socket"),
  Flag.withDefault(defaultSocketPath),
);

const itemArgument = Argument.String("item").pipe(
  Argument.withDescription("Work item to start over: #N, ABC-N, or a GitHub or Linear URL"),
);

const yesFlag = Flag.Boolean("yes").pipe(
  Flag.withDescription("Start over without the confirmation question"),
);

export const startOverCommand = Command.make("start-over", {
  socket: socketFlag,
  workspace: workspaceFlag,
  item: itemArgument,
  yes: yesFlag,
}).pipe(
  Command.withDescription("Delete what cogwork knows about a work item so its Triggers admit it again"),
  Command.withHandler(runStartOver),
);
