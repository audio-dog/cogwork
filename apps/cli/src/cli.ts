import * as Command from "effect/unstable/cli/Command";
import {
  contributionSettingsCommand,
  daemonCommand,
  limitsCommand,
  operationSettingsCommand,
  runEventsCommand,
  runsCommand,
  schedulingCommand,
  statusCommand,
  watchCommand,
} from "./commands";
import { connectionCommand } from "./connection-commands";
import { handBackCommand } from "./hand-back-command";
import { loginCommand } from "./login-commands";
import { modelsCommand } from "./models-commands";
import { pluginCommand } from "./plugin-commands";
import { workspaceCommand } from "./workspace-commands";
import { worktreeCommand } from "./worktree-commands";

export const cli = Command.make("cogwork").pipe(
  Command.withSubcommands([
    daemonCommand,
    contributionSettingsCommand,
    limitsCommand,
    operationSettingsCommand,
    schedulingCommand,
    statusCommand,
    runsCommand,
    runEventsCommand,
    watchCommand,
    handBackCommand,
    worktreeCommand,
    workspaceCommand,
    loginCommand,
    modelsCommand,
    pluginCommand,
    connectionCommand,
  ]),
);
