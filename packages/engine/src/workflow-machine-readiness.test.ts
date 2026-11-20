import {
  ConnectionOverview,
  type ContributionSettingRow,
  defaultControlStore,
  NeedIdentity,
  PluginContribution,
  WorkspaceConfig,
  WorkspaceId,
} from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { ConnectionStore } from "./connection";
import { ControlStore } from "./control-store";
import { HarnessReadinessCache } from "./harness-readiness";
import { PluginManager } from "./plugin";
import type { RegisteredWorkspace } from "./projector";
import { readOnlyRegistry, WorkspaceRegistry } from "./registry-service";
import { MachineReadinessSource, layer as machineReadinessLayer } from "./workflow-machine-readiness";

const need = Schema.decodeSync(NeedIdentity);
const workspaceId = Schema.decodeSync(WorkspaceId);
const decodeOverview = Schema.decodeSync(ConnectionOverview);
const decodePluginContribution = Schema.decodeSync(PluginContribution);

const connectionsWith = (linear: "Ready" | "NotReady") =>
  decodeOverview({
    connections: [
      {
        system: "github",
        connection: {
          id: "github/taylorfsteele",
          system: "github",
          account: "taylorfsteele",
          status: "established",
        },
        readiness: { _tag: "Ready" },
      },
      {
        system: "linear",
        connection: { id: "linear/acme", system: "linear", account: "acme", status: "established" },
        readiness: linear === "Ready" ? { _tag: "Ready" } : { _tag: "NotReady", reason: "Re-connect" },
      },
      { system: "slack", connection: null, readiness: { _tag: "NotReady", reason: "Not connected" } },
    ],
  });

const workspace: RegisteredWorkspace = {
  source: "test",
  contributions: [
    {
      id: "local:repo/skill/effect-ts",
      authority: "local:repo",
      kind: "skill",
      localName: "effect-ts",
      file: "/repos/web/.agents/skills/effect-ts/SKILL.md",
    },
    {
      id: "local:repo/rules/style",
      authority: "local:repo",
      kind: "rules",
      localName: "style",
      file: "/repos/web/.agents/rules/style.md",
    },
    {
      id: "local:repo/mcp/browser",
      authority: "local:repo",
      kind: "mcp-server",
      localName: "browser",
      file: "/repos/web/.agents/mcp/browser.json",
    },
  ],
  config: Schema.decodeSync(WorkspaceConfig)({
    id: workspaceId("web"),
    displayName: "Test workspace",
    checkoutPath: "/repos/web",
    issueTracker: { type: "github" },
  }),
};

const pluginContribution = (
  localName: string,
  kind: "skill" | "mcp-server",
  load: (typeof PluginContribution.Encoded)["load"],
) =>
  decodePluginContribution({
    id: `plugin:linear/${kind === "skill" ? "skill" : "mcp"}/${localName}`,
    authority: "plugin:linear",
    kind,
    localName,
    summary: "Linear",
    file: `/plugins/linear/${localName}`,
    load,
  });

const linearServer = (credentialAvailable: boolean) =>
  pluginContribution("linear", "mcp-server", {
    _tag: "Loaded",
    mcpServer: { endpoint: "https://mcp.linear.app", secretEnv: null, credentialAvailable },
  });

const pluginContributions: ReadonlyArray<PluginContribution> = [
  pluginContribution("triage", "skill", { _tag: "Loaded" }),
  pluginContribution("broken", "skill", { _tag: "Failed", reason: "file is empty" }),
  linearServer(false),
];

const browserOverlay = (workspace: string): ContributionSettingRow => ({
  contribution: { id: "local:repo/mcp/browser", kind: "mcp-server" },
  scope: { _tag: "PrivateWorkspaceOverlay", workspace: workspaceId(workspace) },
  enabled: true,
});

const readinessLayer = (input: {
  readonly settings: ReadonlyArray<ContributionSettingRow>;
  readonly connections: Ref.Ref<ConnectionOverview>;
  readonly plugins: Ref.Ref<ReadonlyArray<PluginContribution>>;
}) => {
  const picture = { ...defaultControlStore, contributionSettings: input.settings };
  return machineReadinessLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ControlStore, { health: "available", seed: picture, picture: Effect.succeed(picture) }),
        Layer.mock(ConnectionStore, { overview: Ref.get(input.connections) }),
        Layer.succeed(WorkspaceRegistry, readOnlyRegistry({ workspaces: [workspace], failures: [] })),
        Layer.mock(HarnessReadinessCache, {
          readiness: () => Effect.succeed({ harnesses: [], checkedAtMillis: 0 }),
        }),
        Layer.mock(PluginManager, { contributions: () => Ref.get(input.plugins) }),
      ),
    ),
  );
};

const readyNeedsWith = Effect.fn("MachineReadinessTest.readyNeedsWith")(function* (
  settings: ReadonlyArray<ContributionSettingRow>,
) {
  const connections = yield* Ref.make(connectionsWith("NotReady"));
  const plugins = yield* Ref.make(pluginContributions);
  const source = yield* MachineReadinessSource.pipe(
    Effect.provide(readinessLayer({ settings, connections, plugins })),
  );
  return (yield* source.current).readyNeeds;
});

describe("MachineReadinessSource", () => {
  it.effect("reports ready Connections and contributions that satisfy a need", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* readyNeedsWith([]), [
        need("github/taylorfsteele"),
        need("local:repo/skill/effect-ts"),
        need("plugin:linear/skill/triage"),
      ]);
    }),
  );

  it.effect.each([
    { case: "this Workspace's overlay switches it on", overlay: "web", ready: true },
    { case: "another Workspace's overlay leaves it off", overlay: "api", ready: false },
  ])("a repository MCP server is a ready need when $case", ({ overlay, ready }) =>
    Effect.gen(function* () {
      const readyNeeds = yield* readyNeedsWith([browserOverlay(overlay)]);

      assert.strictEqual(readyNeeds.includes(need("local:repo/mcp/browser")), ready);
    }),
  );

  it.effect("reads Plugin contributions again when a Connection's readiness changes", () =>
    Effect.gen(function* () {
      const connections = yield* Ref.make(connectionsWith("NotReady"));
      const plugins = yield* Ref.make(pluginContributions);
      const source = yield* MachineReadinessSource.pipe(
        Effect.provide(readinessLayer({ settings: [], connections, plugins })),
      );
      const before = (yield* source.current).readyNeeds;
      yield* Ref.set(plugins, [linearServer(true)]);
      yield* Ref.set(connections, connectionsWith("Ready"));
      const after = (yield* source.current).readyNeeds;

      assert.isFalse(before.includes(need("plugin:linear/mcp/linear")));
      assert.isTrue(after.includes(need("plugin:linear/mcp/linear")));
    }),
  );
});
