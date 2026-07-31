import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Command from "effect/unstable/cli/Command";
import { daemonCommand, runEventsCommand, runsCommand, statusCommand } from "./commands";
import { worktreeCommand } from "./worktreeCommands";

const cli = Command.make("clanker-forge").pipe(
  Command.withSubcommands([daemonCommand, statusCommand, runsCommand, runEventsCommand, worktreeCommand]),
);

NodeRuntime.runMain(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (yield* fs.exists(".env")) yield* Effect.sync(() => process.loadEnvFile());
  }).pipe(Effect.andThen(Command.run(cli, { version: "0.0.1" })), Effect.provide(NodeServices.layer)),
);
