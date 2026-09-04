import { HarnessName, type HarnessOverview } from "@cogwork/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Argument from "effect/unstable/cli/Argument";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";
import { defaultSocketPath } from "./paths";
import { clientLayer, makeDaemonClient } from "./rpc";

const socketFlag = Flag.string("socket").pipe(
  Flag.withDescription("Path to the daemon control socket"),
  Flag.withDefault(defaultSocketPath),
);
const harnessArgument = Argument.string("harness");
const decodeHarness = Schema.decodeUnknownEffect(HarnessName);
const enablementLabel = (enabled: boolean) => (enabled ? "enabled" : "disabled");
const provideClient = (socket: string) => Effect.provide(clientLayer(socket));

export const formatHarnesses = (overview: HarnessOverview) =>
  overview.harnesses
    .toSorted((left, right) => Number(left.enabled) - Number(right.enabled))
    .map((item) => `${item.harness}\t${enablementLabel(item.enabled)}\t${item.state._tag}`)
    .join("\n");

const listHarnesses = Effect.fn("harness.list")(function* () {
  const client = yield* makeDaemonClient();
  yield* Console.log(formatHarnesses(yield* client.GetHarnesses()));
});

const setHarnessEnabled = Effect.fn("harness.setEnabled")(function* (options: {
  readonly harness: string;
  readonly enabled: boolean;
}) {
  const harness = yield* decodeHarness(options.harness);
  const client = yield* makeDaemonClient();
  yield* client.SetHarnessEnabled({ harness, enabled: options.enabled });
  yield* Console.log(`${harness} Harness ${enablementLabel(options.enabled)}.`);
});

const enableCommand = (enabled: boolean) =>
  Command.make(enabled ? "enable" : "disable", {
    socket: socketFlag,
    harness: harnessArgument,
  }).pipe(
    Command.withHandler((options) =>
      setHarnessEnabled({ harness: options.harness, enabled }).pipe(
        Effect.scoped,
        provideClient(options.socket),
      ),
    ),
  );

export const harnessCommand = Command.make("harness").pipe(
  Command.withSubcommands([
    Command.make("list", { socket: socketFlag }).pipe(
      Command.withHandler((options) => listHarnesses().pipe(Effect.scoped, provideClient(options.socket))),
    ),
    enableCommand(true),
    enableCommand(false),
  ]),
);
