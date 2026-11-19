import type { PluginMutationResult } from "@cogwork/contracts";
import * as Console from "effect/Console";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Effect from "effect/Effect";
import { defaultSocketPath } from "./paths";
import { clientLayer, makeDaemonClient } from "./rpc";

const socketFlag = Flag.String("socket").pipe(
  Flag.withDescription("Path to the daemon control socket"),
  Flag.withDefault(defaultSocketPath),
);

const pluginIdArgument = Argument.String("plugin-id");

export const formatPluginMutation = (verb: "Installed" | "Uninstalled", result: PluginMutationResult) =>
  [`${verb} Plugin.`, ...result.notices.map((notice) => `Notice: ${notice}`)].join("\n");

const mutatePlugin = Effect.fn("plugin.mutate")(
  function* (options: {
    readonly socket: string;
    readonly pluginId: string;
    readonly operation: "install" | "uninstall";
  }) {
    const client = yield* makeDaemonClient();
    const result =
      options.operation === "install"
        ? yield* client.InstallPlugin({ pluginId: options.pluginId })
        : yield* client.UninstallPlugin({ pluginId: options.pluginId });
    yield* Console.log(
      formatPluginMutation(options.operation === "install" ? "Installed" : "Uninstalled", result),
    );
  },
  (effect, options) => effect.pipe(Effect.scoped, Effect.provide(clientLayer(options.socket))),
);

const installCommand = Command.make("install", {
  socket: socketFlag,
  pluginId: pluginIdArgument,
}).pipe(Command.withHandler((options) => mutatePlugin({ ...options, operation: "install" })));

const uninstallCommand = Command.make("uninstall", {
  socket: socketFlag,
  pluginId: pluginIdArgument,
}).pipe(Command.withHandler((options) => mutatePlugin({ ...options, operation: "uninstall" })));

export const pluginCommand = Command.make("plugin").pipe(
  Command.withSubcommands([installCommand, uninstallCommand]),
);
