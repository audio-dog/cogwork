import {
  type ControlStore,
  ModelOptionSelections,
  type OperationSettingContext,
  OperationSettingName,
  type OperationSettingRefused,
  OperationSettingUpdate,
  operationSettingNames,
  resolveOperationSetting,
  WorkspaceId,
} from "@cogwork/contracts";
import * as Console from "effect/Console";
import * as Argument from "effect/cli/Argument";
import * as CliError from "effect/cli/CliError";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { controlStoreFlag, currentControlStore, overSocket, socketFlag } from "./commands";
import { makeDaemonClient } from "./rpc";
import { terminalLine } from "./terminal-text";

const operationSettingArgument = Argument.Literals("setting", OperationSettingName.literals);
const operationSettingValueArgument = Argument.String("value");
const operationSettingScopeFlag = Flag.Literals("scope", ["profile", "host", "overlay"]).pipe(
  Flag.withDefault("profile"),
);
const operationSettingWorkspaceFlag = Flag.String("workspace").pipe(Flag.optional);

type ResolvedOperationSettingValue = ReturnType<typeof resolveOperationSetting>;

const isEmptyArray = (value: ResolvedOperationSettingValue) =>
  Array.isArray(value) ? value.length === 0 : false;

const operationSettingFormatRules: ReadonlyArray<{
  readonly when: (value: ResolvedOperationSettingValue) => boolean;
  readonly format: (value: ResolvedOperationSettingValue) => string;
}> = [
  { when: (value) => value === null, format: () => "unset" },
  { when: isEmptyArray, format: () => "unset" },
  {
    when: (value) => typeof value === "object",
    format: (value) => JSON.stringify(value),
  },
  { when: () => true, format: String },
];

const formatOperationSettingValue = (value: ResolvedOperationSettingValue) =>
  operationSettingFormatRules.find(({ when }) => when(value))?.format(value) ?? "unset";

export const formatOperationSettings = (controlStore: ControlStore, context: OperationSettingContext) =>
  operationSettingNames
    .map((setting) =>
      [
        setting,
        formatOperationSettingValue(
          resolveOperationSetting(controlStore.operationSettings, setting, context),
        ),
      ].join(": "),
    )
    .join("\n");

const decodeOperationSettingUpdateInput = Schema.decodeUnknownEffect(OperationSettingUpdate);
const decodeModelOptionSelections = Schema.decodeUnknownEffect(Schema.fromJsonString(ModelOptionSelections));
const operationSettingInputError = (message: string, cause: unknown) =>
  new CliError.UserError({ cause, userMessage: terminalLine(message) });

interface OperationSettingOptions {
  readonly setting: OperationSettingName;
  readonly scope: "profile" | "host" | "overlay";
  readonly workspace: Option.Option<string>;
}

const operationSettingScope = (options: OperationSettingOptions) => {
  if (options.scope === "profile") return { _tag: "SettingsProfile" };
  if (options.scope === "host") return { _tag: "RuntimeHost" };
  return {
    _tag: "PrivateWorkspaceOverlay",
    workspace: Option.getOrElse(options.workspace, () => ""),
  };
};

const operationSettingCell = (options: OperationSettingOptions) => ({
  setting: options.setting,
  scope: operationSettingScope(options),
  level: { _tag: "Default" as const },
});

const operationSettingValueParsers: Record<
  OperationSettingName,
  (value: string) => Effect.Effect<unknown, CliError.UserError>
> = {
  harness: Effect.succeed,
  model: Effect.succeed,
  "model-options": (value: string) =>
    decodeModelOptionSelections(value).pipe(
      Effect.mapError((error) => operationSettingInputError(error.message, error)),
    ),
};

const operationSettingValue = (setting: OperationSettingName, value: string) =>
  operationSettingValueParsers[setting](value);

const decodeOperationSettingUpdate = (input: unknown) =>
  decodeOperationSettingUpdateInput(input).pipe(
    Effect.mapError((error) => operationSettingInputError(error.message, error)),
  );

const operationSettingContext = Effect.fn("commands.operationSettingContext")(function* (options: {
  readonly workspace: Option.Option<string>;
}) {
  const workspace = Option.isSome(options.workspace)
    ? yield* Schema.decodeEffect(WorkspaceId)(options.workspace.value)
    : null;
  return { workspace };
});

export const formatOperationSettingRefusal = (refusal: OperationSettingRefused) =>
  `${terminalLine(refusal.source)} refused ${refusal.setting}: ${terminalLine(refusal.reason)}`;

export const operationSettingError = (refusal: OperationSettingRefused) =>
  operationSettingInputError(formatOperationSettingRefusal(refusal), refusal);

export const makeOperationSettingUpdate = (
  options: OperationSettingOptions,
  value: Option.Option<string>,
) => {
  const cell = operationSettingCell(options);
  if (Option.isNone(value)) return decodeOperationSettingUpdate({ _tag: "Clear", cell });
  return operationSettingValue(options.setting, value.value).pipe(
    Effect.flatMap((settingValue) =>
      decodeOperationSettingUpdate({
        _tag: "Set",
        row: { ...cell, value: settingValue },
      }),
    ),
  );
};

const showOperationSettings = Effect.fn("commands.showOperationSettings")(function* (options: {
  readonly socketPath: string;
  readonly controlStorePath: string;
  readonly workspace: Option.Option<string>;
}) {
  const context = yield* operationSettingContext(options);
  yield* currentControlStore(options).pipe(
    Effect.map((controlStore) => formatOperationSettings(controlStore, context)),
    Effect.flatMap(Console.log),
  );
});

const changeOperationSetting = Effect.fn("commands.changeOperationSetting")(
  function* (
    options: OperationSettingOptions & {
      readonly socketPath: string;
      readonly value: Option.Option<string>;
    },
  ) {
    const client = yield* makeDaemonClient();
    const update = yield* makeOperationSettingUpdate(options, options.value);
    const context = yield* operationSettingContext(options);
    yield* client.SetOperationSetting({ updates: [update] }).pipe(
      Effect.catchTag("OperationSettingRefused", (refusal) => Effect.fail(operationSettingError(refusal))),
      Effect.flatMap((controlStore) => Console.log(formatOperationSettings(controlStore, context))),
    );
  },
  (effect, options) => overSocket(effect, options.socketPath),
);

const operationSettingsShowCommand = Command.make("show", {
  socket: socketFlag,
  controlStore: controlStoreFlag,
  workspace: operationSettingWorkspaceFlag,
}).pipe(
  Command.withHandler(({ socket, controlStore, workspace }) =>
    showOperationSettings({
      socketPath: socket,
      controlStorePath: controlStore,
      workspace,
    }),
  ),
);

const operationSettingOptions = {
  socket: socketFlag,
  setting: operationSettingArgument,
  scope: operationSettingScopeFlag,
  workspace: operationSettingWorkspaceFlag,
};

const operationSettingsSetCommand = Command.make("set", {
  ...operationSettingOptions,
  value: operationSettingValueArgument,
}).pipe(
  Command.withHandler(({ socket, value, ...options }) =>
    changeOperationSetting({ socketPath: socket, ...options, value: Option.some(value) }),
  ),
);

const operationSettingsClearCommand = Command.make("clear", operationSettingOptions).pipe(
  Command.withHandler(({ socket, ...options }) =>
    changeOperationSetting({ socketPath: socket, ...options, value: Option.none() }),
  ),
);

export const operationSettingsCommand = Command.make("operation-settings").pipe(
  Command.withDescription("Show, set, or clear Operation settings"),
  Command.withSubcommands([
    operationSettingsShowCommand,
    operationSettingsSetCommand,
    operationSettingsClearCommand,
  ]),
);
