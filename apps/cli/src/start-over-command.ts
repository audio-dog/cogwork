import {
  type ControlStoreFailure,
  DaemonRpcs,
  keyOf,
  parseWorkItemReference,
  type StartOverRefused,
  type WorkItemRef,
  WorkspaceId,
} from "@cogwork/contracts";
import * as Argument from "effect/cli/Argument";
import * as CliError from "effect/cli/CliError";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Prompt from "effect/cli/Prompt";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as RpcClient from "effect/rpc/RpcClient";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import * as Schema from "effect/Schema";

import { socketFlag } from "./commands";
import { clientLayer } from "./rpc";
import { terminalLine } from "./terminal-text";
import { workspaceFlag } from "./workspace-commands";

interface StartOverOptions {
  readonly workspace: string;
  readonly item: string;
  readonly yes: boolean;
}

const inputError = (message: string, cause: unknown) =>
  new CliError.UserError({ cause, userMessage: terminalLine(message) });

const readWorkItem = Effect.fn("startOver.readWorkItem")(function* (options: StartOverOptions) {
  const workspace = yield* Schema.decodeEffect(WorkspaceId)(options.workspace).pipe(
    Effect.mapError((error) => inputError(`Invalid workspace: ${error.message}`, error)),
  );
  return yield* Effect.fromResult(parseWorkItemReference(workspace, options.item)).pipe(
    Effect.mapError((message) => inputError(message, message)),
  );
});

const questionOf = (item: WorkItemRef) =>
  terminalLine(
    `Start over ${keyOf(item)}? Cogwork deletes the item's coordination records and Workflow action plans.`,
  );

export const startOver = Effect.fn("startOver.confirmAndSend")(function* <EC, RC, ES, RS>(
  options: StartOverOptions,
  confirm: (question: string) => Effect.Effect<boolean, EC, RC>,
  send: (item: WorkItemRef) => Effect.Effect<void, ES, RS>,
) {
  const item = yield* readWorkItem(options);
  const confirmed = options.yes || (yield* confirm(questionOf(item)));
  if (!confirmed) return yield* Console.log("Start over cancelled.");
  yield* send(item);
  yield* Console.log(
    terminalLine(`Started over ${keyOf(item)}. Its Triggers admit it again on the next poll.`),
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
      (item) => client.StartOver({ item }).pipe(Effect.mapError(startOverError)),
    );
  },
  (effect, options) => effect.pipe(Effect.scoped, Effect.provide(clientLayer(options.socket))),
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
