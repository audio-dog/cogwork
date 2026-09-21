import * as Command from "effect/unstable/cli/Command";
import {
  contributionSettingsCommand,
  daemonCommand,
  limitsCommand,
  metricsCommand,
  operationSettingsCommand,
  runEventsCommand,
  runsCommand,
  schedulingCommand,
  statusCommand,
  watchCommand,
} from "./commands";
import { connectionCommand } from "./connection-commands";
import { handBackCommand } from "./hand-back-command";
import { harnessCommand } from "./harness-commands";
import { loginCommand } from "./login-commands";
import { pluginCommand } from "./plugin-commands";
import { replayCommand } from "./replay-commands";
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
    metricsCommand,
    runsCommand,
    runEventsCommand,
    watchCommand,
    handBackCommand,
    worktreeCommand,
    workspaceCommand,
    loginCommand,
    pluginCommand,
    connectionCommand,
    harnessCommand,
    replayCommand,
  ]),
);
