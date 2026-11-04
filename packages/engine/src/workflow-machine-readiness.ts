import {
  type ConnectionOverview,
  ConnectionReadiness,
  type ContributionSettingRow,
  contributionSettingApplies,
  defaultContributionEnabled,
  type FileContribution,
  type FileContributionKind,
  HarnessName,
  HarnessState,
  type MachineReadiness,
  NeedIdentity,
  type OperationSettingRow,
  type PluginContribution,
  PluginContributionLoad,
  type PluginInstall,
  resolveContributionEnabled,
  type WorkspaceId,
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
import { PluginManager } from "./plugin";
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

const isUsablePluginContribution = ({ load }: PluginContribution) =>
  PluginContributionLoad.guards.Loaded(load) && load.mcpServer?.credentialAvailable !== false;

interface NeedInput {
  readonly contribution: FileContribution;
  readonly settings: ReadonlyArray<ContributionSettingRow>;
  readonly workspace: WorkspaceId;
}

const mcpServerSwitchedOn = ({ contribution, settings, workspace }: NeedInput) =>
  resolveContributionEnabled(
    settings.filter(
      ({ contribution: { id }, scope }) =>
        id === contribution.id && contributionSettingApplies(scope, workspace),
    ),
  ) ?? defaultContributionEnabled(contribution.authority);

const satisfiesNeedByKind = {
  "mcp-server": mcpServerSwitchedOn,
  skill: () => true,
  subagent: () => true,
  command: () => true,
  rules: () => false,
} satisfies Record<FileContributionKind, (input: NeedInput) => boolean>;

const satisfiesNeed = (input: NeedInput) => satisfiesNeedByKind[input.contribution.kind](input);

const pluginReadKey = (installs: ReadonlyArray<PluginInstall>, overview: ConnectionOverview) =>
  JSON.stringify([
    installs.map(({ pluginId, resolvedIdentity }) => [pluginId, resolvedIdentity]),
    overview.connections.map(({ system, connection, readiness }) => [system, connection?.id, readiness._tag]),
  ]);

interface PluginRead {
  readonly key: string;
  readonly contributions: ReadonlyArray<PluginContribution>;
}

export const make = Effect.gen(function* () {
  const store = yield* ControlStore;
  const registry = yield* WorkspaceRegistry;
  const connections = yield* ConnectionStore;
  const harnesses = yield* HarnessReadinessCache;
  const plugins = yield* PluginManager;
  const pluginReads = yield* Ref.make<ReadonlyMap<WorkspaceId, PluginRead>>(new Map());

  const pluginContributions = Effect.fn("MachineReadinessSource.pluginContributions")(function* (
    workspace: WorkspaceId,
    key: string,
  ) {
    const previous = (yield* Ref.get(pluginReads)).get(workspace);
    if (previous?.key === key) return previous.contributions;
    return yield* plugins.contributions(workspace).pipe(
      Effect.map((contributions) => contributions.filter(isUsablePluginContribution)),
      Effect.tap((contributions) =>
        Ref.update(pluginReads, (reads) => new Map(reads).set(workspace, { key, contributions })),
      ),
      Effect.orElseSucceed(() => previous?.contributions ?? []),
    );
  });

  const current = Effect.fn("MachineReadinessSource.current")(function* () {
    const picture =
      store.health === "available" ? yield* store.picture.pipe(Effect.orElseSucceed(() => null)) : null;
    const registryState = yield* registry.state;
    const connectionOverview = yield* connections.overview.pipe(
      Effect.orElseSucceed(() => ({ connections: [] })),
    );
    const harnessReadiness = yield* harnesses.readiness(picture?.harnessSettings ?? []);
    const settings = picture?.contributionSettings ?? [];
    const key = pluginReadKey(picture?.pluginInstalls ?? [], connectionOverview);
    const satisfyingIds = yield* Effect.forEach(registryState.workspaces, ({ config, contributions }) =>
      Effect.map(pluginContributions(config.name, key), (fromPlugins) =>
        [...contributions, ...fromPlugins]
          .filter((contribution) => satisfiesNeed({ contribution, settings, workspace: config.name }))
          .map(({ id }) => id),
      ),
    );
    const readyConnections = connectionOverview.connections.flatMap(({ connection, readiness }) =>
      connection !== null && ConnectionReadiness.guards.Ready(readiness) ? [connection.id] : [],
    );
    const readyNeedIds = new Set([...readyConnections, ...satisfyingIds.flat()]);
    return {
      workspaces: registryState.workspaces.map(({ config }) => ({
        id: config.name,
        binds: [config.issueTracker.type, ...(config.sourceControl ? [config.sourceControl.type] : [])],
      })),
      connections: connectionOverview.connections.flatMap(({ system, connection, readiness }) =>
        connection === null ? [] : [connectionReadinessOf(system, readiness)],
      ),
      harnesses: harnessReadiness.harnesses.map(({ harness: name, enabled, state }) => ({
        name,
        available: enabled && HarnessState.guards.Ready(state),
      })),
      defaultHarness: defaultHarnessOf(picture?.operationSettings ?? []),
      readyNeeds: [...readyNeedIds].map((id) => needOf(id)),
    } satisfies MachineReadiness;
  });

  return { current: current() } satisfies MachineReadinessSourceService;
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
