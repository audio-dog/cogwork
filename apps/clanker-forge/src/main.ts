import * as fs from "node:fs";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Command from "effect/unstable/cli/Command";
import { daemonCommand, statusCommand } from "./commands";
import { worktreeCommand } from "./worktreeCommands";

if (fs.existsSync(".env")) process.loadEnvFile();

const cli = Command.make("clanker-forge").pipe(
  Command.withSubcommands([daemonCommand, statusCommand, worktreeCommand]),
);

NodeRuntime.runMain(Command.run(cli, { version: "0.0.1" }).pipe(Effect.provide(NodeServices.layer)));
