import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Command from "effect/unstable/cli/Command";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { daemonCommand, runEventsCommand, runsCommand, statusCommand, watchCommand } from "./commands";
import { loginCommand } from "./login-commands";
import { modelsCommand } from "./models-commands";
import { workspaceCommand } from "./workspace-commands";
import { worktreeCommand } from "./worktree-commands";

const cli = Command.make("cogwork").pipe(
  Command.withSubcommands([
    daemonCommand,
    statusCommand,
    runsCommand,
    runEventsCommand,
    watchCommand,
    worktreeCommand,
    workspaceCommand,
    loginCommand,
    modelsCommand,
  ]),
);

NodeRuntime.runMain(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (yield* fs.exists(".env")) yield* Effect.sync(() => process.loadEnvFile());
  }).pipe(
    Effect.andThen(Command.run(cli, { version: "0.0.1" })),
    Effect.provide(Layer.mergeAll(FetchHttpClient.layer, NodeServices.layer)),
  ),
);
