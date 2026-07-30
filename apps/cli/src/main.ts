import * as fs from "node:fs";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Command from "effect/unstable/cli/Command";
import { daemonCommand, runEventsCommand, runsCommand, statusCommand } from "./commands";

if (fs.existsSync(".env")) process.loadEnvFile();

const cli = Command.make("clanker-forge").pipe(
  Command.withSubcommands([daemonCommand, statusCommand, runsCommand, runEventsCommand]),
);

NodeRuntime.runMain(Command.run(cli, { version: "0.0.1" }).pipe(Effect.provide(NodeServices.layer)));
