import { WorkspaceId, WorkspaceRegistration, type WorkspaceState } from "@cogwork/contracts";
import { Git } from "@cogwork/engine";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";
import { defaultSocketPath } from "./paths";
import { gitLayer } from "./platform";
import { clientLayer, makeDaemonClient } from "./rpc";

const socketFlag = Flag.string("socket").pipe(
  Flag.withDescription("Path to the daemon control socket"),
  Flag.withDefault(defaultSocketPath),
);

const inputFlag = Flag.string("input").pipe(Flag.withDescription("One-time JSON registration input"));
export const workspaceFlag = Flag.string("workspace").pipe(Flag.withDescription("WorkspaceId to manage"));
const checkoutFlag = Flag.string("checkout").pipe(Flag.withDescription("New absolute checkout path"));

const decodeRegistration = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkspaceRegistration));
const decodeWorkspaceId = Schema.decodeUnknownEffect(WorkspaceId);

const readRegistration = Effect.fn("workspace.readRegistration")(function* (inputPath: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(inputPath).pipe(Effect.flatMap(decodeRegistration));
});

const captureRemote = Effect.fn("workspace.captureRemote")(function* (registration: WorkspaceRegistration) {
  if (registration.gitRemote) return registration;
  const git = yield* Git.Git;
  const gitRemote = yield* git
    .remoteUrl(registration.checkoutPath, registration.worktrees?.remote ?? "origin")
    .pipe(Effect.orElseSucceed(() => undefined));
  return { ...registration, ...(gitRemote ? { gitRemote } : {}) };
});

export const formatRegistrationResult = (displayName: string, workspace: WorkspaceState) => {
  if (workspace._tag === "Registered") {
    return `Registered ${workspace.displayName ?? workspace.name} as ${workspace.name}.`;
  }
  if (workspace.name === undefined) {
    return `Workspace input failed for ${workspace.source}: ${workspace.message}`;
  }
  return `Registered ${displayName} as ${workspace.name}, but Workspace input failed: ${workspace.message}`;
};

const runRegister = Effect.fn("workspace.register")(function* (options: {
  readonly socket: string;
  readonly input: string;
}) {
  const registration = yield* readRegistration(options.input).pipe(Effect.flatMap(captureRemote));
  const client = yield* makeDaemonClient();
  const workspace = yield* client.RegisterWorkspace({ registration });
  const message = formatRegistrationResult(registration.name, workspace);
  if (workspace._tag === "Failed") return yield* Console.error(message);
  yield* Console.log(message);
});

export const registerWorkspace = Effect.fn("workspace.registerWithLayers")(function* (options: {
  readonly socket: string;
  readonly input: string;
}) {
  return yield* runRegister(options).pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(clientLayer(options.socket), gitLayer)),
  );
});

export const formatRebindResult = (workspace: WorkspaceState) => {
  if (workspace._tag === "Failed") {
    return `Re-bound ${workspace.displayName ?? workspace.name ?? workspace.source}, but Workspace input failed: ${workspace.message}`;
  }
  const identity = workspace.displayName ? `${workspace.displayName} (${workspace.name})` : workspace.name;
  return `Re-bound ${identity} to ${workspace.checkoutPath}.`;
};

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
  if (rebound._tag === "Failed") return yield* Console.error(message);
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

const registerCommand = Command.make("register", { socket: socketFlag, input: inputFlag }).pipe(
  Command.withHandler(registerWorkspace),
);

const deregisterCommand = Command.make("deregister", { socket: socketFlag, workspace: workspaceFlag }).pipe(
  Command.withHandler(deregisterWorkspace),
);

const rebindCommand = Command.make("re-bind", {
  socket: socketFlag,
  workspace: workspaceFlag,
  checkout: checkoutFlag,
}).pipe(Command.withHandler(rebindWorkspace));

export const workspaceCommand = Command.make("workspace").pipe(
  Command.withSubcommands([registerCommand, deregisterCommand, rebindCommand]),
);
