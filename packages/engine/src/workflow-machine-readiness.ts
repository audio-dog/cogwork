import {
  ConnectionReadiness,
  HarnessName,
  HarnessState,
  type MachineReadiness,
  NeedIdentity,
  type OperationSettingRow,
} from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { ConnectionStore } from "./connection";
import { ControlStore } from "./control-store";
import { HarnessReadinessCache } from "./harness-readiness";
import { WorkspaceRegistry } from "./registry";

export interface MachineReadinessSourceService {
  readonly current: Effect.Effect<MachineReadiness>;
}

export class MachineReadinessSource extends Context.Service<
  MachineReadinessSource,
  MachineReadinessSourceService
>()("@cogwork/engine/workflow-machine-readiness/MachineReadinessSource") {}

const isDefaultHarnessSetting = (
  row: OperationSettingRow,
): row is Extract<OperationSettingRow, { readonly setting: "harness" }> =>
  row.setting === "harness" && row.level._tag === "Default" && row.scope._tag === "SettingsProfile";

const decodeHarnessOption = Schema.decodeUnknownOption(HarnessName);
const needOf = Schema.decodeSync(NeedIdentity);

const defaultHarnessOf = (rows: ReadonlyArray<OperationSettingRow>) =>
  Option.getOrNull(decodeHarnessOption(rows.find(isDefaultHarnessSetting)?.value));

const connectionReadinessOf = (
  system: MachineReadiness["connections"][number]["system"],
  readiness: ConnectionReadiness,
): MachineReadiness["connections"][number] =>
  ConnectionReadiness.match(readiness, {
    Ready: (): MachineReadiness["connections"][number] => ({ system, ready: true, reason: null }),
    NotReady: ({ reason }): MachineReadiness["connections"][number] => ({
      system,
      ready: false,
      reason,
    }),
  });

export const make = Effect.gen(function* () {
  const store = yield* ControlStore;
  const registry = yield* WorkspaceRegistry;
  const connections = yield* ConnectionStore;
  const harnesses = yield* HarnessReadinessCache;

  return {
    current: Effect.all({
      picture:
        store.health === "available"
          ? store.picture.pipe(Effect.orElseSucceed(() => null))
          : Effect.succeed(null),
      registryState: registry.state,
      connectionOverview: connections.overview.pipe(Effect.orElseSucceed(() => ({ connections: [] }))),
    }).pipe(
      Effect.flatMap(({ picture, registryState, connectionOverview }) =>
        harnesses.readiness(picture?.harnessSettings ?? []).pipe(
          Effect.map(
            (harnessReadiness) =>
              ({
                workspaces: registryState.workspaces.map(({ config }) => ({
                  id: config.name,
                  binds: [
                    config.issueTracker.type,
                    ...(config.sourceControl ? [config.sourceControl.type] : []),
                  ],
                })),
                connections: connectionOverview.connections.flatMap(({ system, connection, readiness }) =>
                  connection === null ? [] : [connectionReadinessOf(system, readiness)],
                ),
                harnesses: harnessReadiness.harnesses.map(({ harness: name, enabled, state }) => ({
                  name,
                  available: enabled && HarnessState.guards.Ready(state),
                })),
                defaultHarness: defaultHarnessOf(picture?.operationSettings ?? []),
                readyNeeds: connectionOverview.connections.flatMap(({ connection, readiness }) =>
                  connection !== null && ConnectionReadiness.guards.Ready(readiness)
                    ? [needOf(connection.id)]
                    : [],
                ),
              }) satisfies MachineReadiness,
          ),
        ),
      ),
    ),
  } satisfies MachineReadinessSourceService;
});

export const layer = Layer.effect(MachineReadinessSource, make);

export class MachineReadinessTestState extends Context.Service<
  MachineReadinessTestState,
  Ref.Ref<MachineReadiness>
>()("@cogwork/engine/workflow-machine-readiness/MachineReadinessTestState") {}

export const testLayer = (initial: MachineReadiness) => {
  const state = Layer.effect(MachineReadinessTestState, Ref.make(initial));
  return Layer.effect(
    MachineReadinessSource,
    Effect.map(MachineReadinessTestState, (ref) => ({ current: Ref.get(ref) })),
  ).pipe(Layer.provideMerge(state));
};
