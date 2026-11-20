import { WorkspaceId, WorkspaceRegistration, WorkspaceState, WorkspaceUpdate } from "@cogwork/contracts";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { defaultSocketPath } from "./paths";
import { clientLayer, makeDaemonClient } from "./rpc";

const socketFlag = Flag.String("socket").pipe(
  Flag.withDescription("Path to the daemon control socket"),
  Flag.withDefault(defaultSocketPath),
);

const inputFlag = Flag.String("input").pipe(Flag.withDescription("One-time JSON registration input"));
export const workspaceFlag = Flag.String("workspace").pipe(Flag.withDescription("WorkspaceId to manage"));
const checkoutFlag = Flag.String("checkout").pipe(Flag.withDescription("New absolute checkout path"));

const decodeRegistration = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkspaceRegistration));
export const decodeWorkspaceUpdateJson = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkspaceUpdate));
const decodeWorkspaceId = Schema.decodeUnknownEffect(WorkspaceId);

const readRegistration = Effect.fn("workspace.readRegistration")(function* (inputPath: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(inputPath).pipe(Effect.flatMap(decodeRegistration));
});

const readUpdate = Effect.fn("workspace.readUpdate")(function* (inputPath: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(inputPath).pipe(Effect.flatMap(decodeWorkspaceUpdateJson));
});
export const formatRegistrationResult = (requestedName: string, workspace: WorkspaceState) =>
  WorkspaceState.match(workspace, {
    Registered: (registered) => `Registered ${registered.displayName} as ${registered.id}.`,
    Failed: (failed) =>
      failed.id === undefined
        ? `Workspace input failed for ${failed.source}: ${failed.message}`
        : `Registered ${requestedName} as ${failed.id}, but Workspace input failed: ${failed.message}`,
  });

const runRegister = Effect.fn("workspace.register")(function* (options: {
  readonly socket: string;
  readonly input: string;
}) {
  const registration = yield* readRegistration(options.input);
  const client = yield* makeDaemonClient();
  const workspace = yield* client.RegisterWorkspace({ registration });
  const message = formatRegistrationResult(registration.displayName, workspace);
  if (WorkspaceState.guards.Failed(workspace)) return yield* Console.error(message);
  yield* Console.log(message);
});

export const registerWorkspace = Effect.fn("workspace.registerWithLayers")(function* (options: {
  readonly socket: string;
  readonly input: string;
}) {
  return yield* runRegister(options).pipe(Effect.scoped, Effect.provide(clientLayer(options.socket)));
});

export const formatRebindResult = (workspace: WorkspaceState) =>
  WorkspaceState.match(workspace, {
    Failed: (failed) =>
      `Re-bound ${failed.displayName ?? failed.id ?? failed.source}, but Workspace input failed: ${failed.message}`,
    Registered: (registered) =>
      `Re-bound ${registered.displayName} (${registered.id}) to ${registered.checkoutPath}.`,
  });

export const formatUpdateResult = (workspace: WorkspaceState) =>
  WorkspaceState.match(workspace, {
    Failed: (failed) =>
      `Updated ${failed.displayName ?? failed.id ?? failed.source}, but Workspace input failed: ${failed.message}`,
    Registered: (registered) => `Updated ${registered.displayName}.`,
  });

const runDeregister = Effect.fn("workspace.deregister")(function* (options: {
  readonly socket: string;
  readonly workspace: string;
}) {
  const workspace = yield* decodeWorkspaceId(options.workspace);
  const client = yield* makeDaemonClient();
  const deregistered = yield* client.DeregisterWorkspace({ workspace });
  yield* Console.log(`Deregistered ${deregistered}.`);
});

const runRebind = Effect.fn("workspace.rebind")(function* (options: {
  readonly socket: string;
  readonly workspace: string;
  readonly checkout: string;
}) {
  const workspace = yield* decodeWorkspaceId(options.workspace);
  const client = yield* makeDaemonClient();
  const rebound = yield* client.RebindWorkspace({ workspace, checkoutPath: options.checkout });
  const message = formatRebindResult(rebound);
  if (WorkspaceState.guards.Failed(rebound)) return yield* Console.error(message);
  yield* Console.log(message);
});

const runUpdate = Effect.fn("workspace.update")(function* (options: {
  readonly socket: string;
  readonly workspace: string;
  readonly input: string;
}) {
  const workspace = yield* decodeWorkspaceId(options.workspace);
  const update = yield* readUpdate(options.input);
  const client = yield* makeDaemonClient();
  const updated = yield* client.UpdateWorkspace({ workspace, update });
  const message = formatUpdateResult(updated);
  if (WorkspaceState.guards.Failed(updated)) return yield* Console.error(message);
  yield* Console.log(message);
});

export const deregisterWorkspace = Effect.fn("workspace.deregisterWithLayers")(function* (options: {
  readonly socket: string;
  readonly workspace: string;
}) {
  return yield* runDeregister(options).pipe(Effect.scoped, Effect.provide(clientLayer(options.socket)));
});

export const rebindWorkspace = Effect.fn("workspace.rebindWithLayers")(function* (options: {
  readonly socket: string;
  readonly workspace: string;
  readonly checkout: string;
}) {
  return yield* runRebind(options).pipe(Effect.scoped, Effect.provide(clientLayer(options.socket)));
});

export const updateWorkspace = Effect.fn("workspace.updateWithLayers")(function* (options: {
  readonly socket: string;
  readonly workspace: string;
  readonly input: string;
}) {
  return yield* runUpdate(options).pipe(Effect.scoped, Effect.provide(clientLayer(options.socket)));
});

const registerCommand = Command.make("register", { socket: socketFlag, input: inputFlag }).pipe(
  Command.withHandler(registerWorkspace),
);

const deregisterCommand = Command.make("deregister", { socket: socketFlag, workspace: workspaceFlag }).pipe(
  Command.withHandler(deregisterWorkspace),
);

const updateCommand = Command.make("update", {
  socket: socketFlag,
  workspace: workspaceFlag,
  input: inputFlag,
}).pipe(Command.withHandler(updateWorkspace));

const rebindCommand = Command.make("re-bind", {
  socket: socketFlag,
  workspace: workspaceFlag,
  checkout: checkoutFlag,
}).pipe(Command.withHandler(rebindWorkspace));

export const workspaceCommand = Command.make("workspace").pipe(
  Command.withSubcommands([registerCommand, updateCommand, deregisterCommand, rebindCommand]),
);
