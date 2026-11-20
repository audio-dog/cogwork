import * as Command from "effect/cli/Command";

import { connectionCommand } from "./connection-commands";
import { contributionSettingsCommand } from "./contribution-settings-commands";
import { daemonCommand } from "./daemon-commands";
import { handBackCommand } from "./hand-back-command";
import { harnessCommand } from "./harness-commands";
import { limitsCommand } from "./limits-commands";
import { loginCommand } from "./login-commands";
import { operationSettingsCommand } from "./operation-settings-commands";
import { pluginCommand } from "./plugin-commands";
import { replayCommand } from "./replay-commands";
import { metricsCommand, runEventsCommand, runsCommand } from "./run-commands";
import { schedulingCommand } from "./scheduling-commands";
import { statusCommand } from "./status-commands";
import { watchCommand } from "./watch-commands";
import { workflowCommand } from "./workflow-commands";
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
    workflowCommand,
  ]),
);
