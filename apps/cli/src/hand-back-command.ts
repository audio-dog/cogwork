import {
  DaemonRpcs,
  keyOf,
  TrimmedNonEmptyString,
  type WorkflowTouchpointFailure,
  WorkItemId,
  WorkItemRef,
  WorkspaceId,
} from "@cogwork/contracts";
import * as Argument from "effect/cli/Argument";
import * as CliError from "effect/cli/CliError";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as RpcClient from "effect/rpc/RpcClient";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import * as Schema from "effect/Schema";

import { defaultSocketPath } from "./paths";
import { clientLayer } from "./rpc";
import { terminalLine } from "./terminal-text";
import { workspaceFlag } from "./workspace-commands";

interface HandBackOptions {
  readonly workspace: string;
  readonly item: string;
  readonly note?: string;
}

interface HandBackRequest {
  readonly item: WorkItemRef;
  readonly note?: string;
}

const inputError = (message: string, cause: unknown) =>
  new CliError.UserError({ cause, userMessage: message });

const decodeInput =
  <A, I>(schema: Schema.Codec<A, I>) =>
  (input: unknown) =>
    Schema.decodeUnknownEffect(schema)(input).pipe(
      Effect.mapError((error) => inputError(`Invalid hand-back input: ${error.message}`, error)),
    );

const decodeWorkspace = decodeInput(WorkspaceId);
const decodeWorkItem = decodeInput(WorkItemId);
const decodeNote = decodeInput(TrimmedNonEmptyString);

export const makeHandBackRequest = Effect.fn("handBack.makeRequest")(function* (options: HandBackOptions) {
  const workspace = yield* decodeWorkspace(options.workspace);
  const workItem = yield* decodeWorkItem(options.item);
  const note = options.note === undefined ? undefined : yield* decodeNote(options.note);
  return {
    item: WorkItemRef.cases.Issue.make({ workspace, id: workItem }),
    ...(note ? { note } : {}),
  };
});

export const handBackError = (error: WorkflowTouchpointFailure | RpcClientError) => {
  return inputError(terminalLine(`Could not hand back the work item: ${error.message}`), error);
};

export const formatHandBackResult = (request: HandBackRequest) =>
  terminalLine(`Handed back ${keyOf(request.item)}`);

const runHandBack = Effect.fn("handBack.run")(
  function* (options: HandBackOptions & { readonly socket: string }) {
    const request = yield* makeHandBackRequest(options);
    const client = yield* RpcClient.make(DaemonRpcs);
    yield* client.HandBack(request).pipe(Effect.mapError(handBackError));
    yield* Console.log(formatHandBackResult(request));
  },
  (effect, options) => effect.pipe(Effect.scoped, Effect.provide(clientLayer(options.socket))),
);

const socketFlag = Flag.String("socket").pipe(
  Flag.withDescription("Path to the daemon control socket"),
  Flag.withDefault(defaultSocketPath),
);

const itemArgument = Argument.String("item").pipe(Argument.withDescription("Parked work item to hand back"));

const noteFlag = Flag.String("note").pipe(
  Flag.withDescription("Optional note to add to the work item"),
  Flag.optional,
);

export const handBackCommand = Command.make("hand-back", {
  socket: socketFlag,
  workspace: workspaceFlag,
  item: itemArgument,
  note: noteFlag,
}).pipe(
  Command.withDescription("Hand a parked work item back to cogwork"),
  Command.withHandler(({ note, ...options }) =>
    runHandBack(
      Option.match(note, {
        onNone: () => options,
        onSome: (value) => ({ ...options, note: value }),
      }),
    ),
  ),
);
