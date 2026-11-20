import { ContributionSettingScope, ContributionSettingUpdate, type ControlStore } from "@cogwork/contracts";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  type ControlStoreReadOptions,
  controlStoreFlag,
  currentControlStore,
  overSocket,
  socketFlag,
} from "./commands";
import { makeDaemonClient } from "./rpc";

const contributionSettingArgument = Argument.String("contribution");
const contributionSettingValueArgument = Argument.Literals("value", ["on", "off"]);
const contributionSettingScopeFlag = Flag.Literals("scope", ["profile", "overlay"]).pipe(
  Flag.withDefault("profile"),
);
const contributionSettingWorkspaceFlag = Flag.String("workspace").pipe(Flag.optional);

class ContributionSettingInputError extends Data.TaggedError("ContributionSettingInputError")<{
  readonly message: string;
}> {}

const decodeContributionSettingUpdateInput = Schema.decodeUnknownEffect(ContributionSettingUpdate);

interface ContributionSettingOptions {
  readonly contribution: string;
  readonly scope: "profile" | "overlay";
  readonly workspace: Option.Option<string>;
}

const contributionSettingScope = (options: ContributionSettingOptions) =>
  options.scope === "profile"
    ? { _tag: "SettingsProfile" }
    : {
        _tag: "PrivateWorkspaceOverlay",
        workspace: Option.getOrElse(options.workspace, () => ""),
      };

const decodeContributionSettingUpdate = (input: unknown) =>
  decodeContributionSettingUpdateInput(input).pipe(
    Effect.mapError((error) => new ContributionSettingInputError({ message: error.message })),
  );

export const makeContributionSettingUpdate = (
  options: ContributionSettingOptions,
  value: Option.Option<"on" | "off">,
) => {
  const cell = {
    contribution: { id: options.contribution, kind: "mcp-server" },
    scope: contributionSettingScope(options),
  };
  if (Option.isNone(value)) return decodeContributionSettingUpdate({ _tag: "Clear", cell });
  return decodeContributionSettingUpdate({
    _tag: "Set",
    row: { ...cell, enabled: value.value === "on" },
  });
};

export const formatContributionSettings = (controlStore: ControlStore) => {
  if (controlStore.contributionSettings.length === 0) return "(no contribution settings)";
  return controlStore.contributionSettings
    .map((row) => {
      const scope = ContributionSettingScope.match(row.scope, {
        SettingsProfile: () => "profile",
        PrivateWorkspaceOverlay: ({ workspace }) => `overlay:${workspace}`,
      });
      const diagnostic = row.diagnostic ? ` (${row.diagnostic._tag.toLowerCase()})` : "";
      return `${row.contribution.id} [${scope}]: ${row.enabled ? "on" : "off"}${diagnostic}`;
    })
    .join("\n");
};

const showContributionSettings = Effect.fn("commands.showContributionSettings")(function* (
  options: ControlStoreReadOptions,
) {
  yield* currentControlStore(options).pipe(
    Effect.map(formatContributionSettings),
    Effect.flatMap(Console.log),
  );
});

const changeContributionSetting = Effect.fn("commands.changeContributionSetting")(
  function* (
    options: ContributionSettingOptions & {
      readonly socketPath: string;
      readonly value: Option.Option<"on" | "off">;
    },
  ) {
    const client = yield* makeDaemonClient();
    const update = yield* makeContributionSettingUpdate(options, options.value);
    const controlStore = yield* client.SetContributionSetting({ update });
    yield* Console.log(formatContributionSettings(controlStore));
  },
  (effect, options) => overSocket(effect, options.socketPath),
);

const contributionSettingsShowCommand = Command.make("show", {
  socket: socketFlag,
  controlStore: controlStoreFlag,
}).pipe(
  Command.withHandler(({ socket, controlStore }) =>
    showContributionSettings({ socketPath: socket, controlStorePath: controlStore }),
  ),
);

const contributionSettingOptions = {
  socket: socketFlag,
  contribution: contributionSettingArgument,
  scope: contributionSettingScopeFlag,
  workspace: contributionSettingWorkspaceFlag,
};

const contributionSettingsSetCommand = Command.make("set", {
  ...contributionSettingOptions,
  value: contributionSettingValueArgument,
}).pipe(
  Command.withHandler(({ socket, value, ...options }) =>
    changeContributionSetting({ socketPath: socket, ...options, value: Option.some(value) }),
  ),
);

const contributionSettingsClearCommand = Command.make("clear", contributionSettingOptions).pipe(
  Command.withHandler(({ socket, ...options }) =>
    changeContributionSetting({ socketPath: socket, ...options, value: Option.none() }),
  ),
);

export const contributionSettingsCommand = Command.make("contribution-settings").pipe(
  Command.withDescription("Show, set, or clear contribution settings"),
  Command.withSubcommands([
    contributionSettingsShowCommand,
    contributionSettingsSetCommand,
    contributionSettingsClearCommand,
  ]),
);
