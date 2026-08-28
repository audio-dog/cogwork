import {
  defaultControlStore,
  initialBoard,
  localOwnerId,
  type PluginOverview,
  WorkspaceId,
} from "@cogwork/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { describe, expect, it } from "vitest";
import { placeholderConfiguration } from "./configuration-placeholder";
import { resolveEnablement, viewOf } from "./configuration-resolve";
import {
  configurationWithPlugins,
  pluginDetailOf,
  pluginOverviewOf,
  pluginQueryFailure,
  pluginSurfaceOf,
} from "./plugin-configuration";

const overview: PluginOverview = {
  plugins: [
    {
      pluginId: "linear",
      name: "Linear",
      summary: "Linear tools",
      record: {
        pluginId: "linear",
        resolvedIdentity: "linear@1.0.0",
        principal: localOwnerId,
        installedAtMillis: 1,
      },
      resolvedIdentity: "linear@1.0.0",
      requiredConnections: ["Linear"],
      contributions: [
        {
          id: "plugin:linear/mcp/linear",
          authority: "plugin:linear",
          kind: "mcp-server",
          localName: "linear",
          summary: "Linear MCP",
          file: "/plugins/linear/mcp/linear.json",
          load: {
            _tag: "Loaded",
            mcpServer: {
              endpoint: "https://mcp.linear.app/mcp",
              secretEnv: "LINEAR_API_KEY",
              credentialAvailable: false,
            },
          },
        },
      ],
      manifestFailure: null,
    },
    {
      pluginId: "github",
      name: "GitHub",
      summary: "GitHub tools",
      record: null,
      resolvedIdentity: "github@1.0.0",
      requiredConnections: ["GitHub"],
      contributions: [],
      manifestFailure: null,
    },
  ],
};

describe("configurationWithPlugins", () => {
  it("projects installed, attention, and catalog data", () => {
    const picture = configurationWithPlugins(placeholderConfiguration, overview, {
      ...defaultControlStore,
      contributionSettings: [
        {
          contribution: { id: "plugin:linear/mcp/linear", kind: "mcp-server" },
          scope: { _tag: "SettingsProfile" },
          enabled: true,
        },
      ],
    });

    expect(picture.plugins.map((plugin) => plugin.record.pluginId)).toEqual(["linear"]);
    expect(picture.catalogPlugins.map((plugin) => plugin.pluginId)).toEqual(["github"]);
    expect(picture.contributions.at(-1)?.rows[0]?.value).toBe(true);
    expect(picture.contributions.at(-1)?.readiness?._tag).toBe("not-ready");
  });

  it("projects Plugin MCP enablement for each workspace overlay", () => {
    const firstWorkspace = placeholderConfiguration.workspaces.at(0);
    if (!firstWorkspace) throw new Error("fixture needs a workspace");
    const picture = configurationWithPlugins(placeholderConfiguration, overview, {
      ...defaultControlStore,
      contributionSettings: [
        {
          contribution: { id: "plugin:linear/mcp/linear", kind: "mcp-server" },
          scope: { _tag: "SettingsProfile" },
          enabled: true,
        },
        {
          contribution: { id: "plugin:linear/mcp/linear", kind: "mcp-server" },
          scope: { _tag: "PrivateWorkspaceOverlay", workspace: firstWorkspace.id },
          enabled: false,
        },
      ],
    });

    const instances = picture.contributions.filter(
      (contribution) => contribution.id === "plugin:linear/mcp/linear",
    );

    expect(
      instances.map((contribution) => ({
        workspace: contribution.definedIn,
        enabled: resolveEnablement(contribution, viewOf(contribution)).effective,
      })),
    ).toEqual(
      picture.workspaces.map((workspace) => ({
        workspace: workspace.id,
        enabled: workspace.id !== firstWorkspace.id,
      })),
    );
  });

  it("projects a dangling Plugin overlay for a removed workspace", () => {
    const removed = Schema.decodeSync(WorkspaceId)("removed");
    const picture = configurationWithPlugins(placeholderConfiguration, overview, {
      ...defaultControlStore,
      contributionSettings: [
        {
          contribution: { id: "plugin:linear/mcp/linear", kind: "mcp-server" },
          scope: { _tag: "PrivateWorkspaceOverlay", workspace: removed },
          enabled: false,
          diagnostic: {
            _tag: "Dangling",
            source: "Control store",
            detail: "No loaded MCP server has this identity.",
          },
        },
      ],
    });

    expect(
      picture.contributions
        .filter((contribution) => contribution.id === "plugin:linear/mcp/linear")
        .flatMap((contribution) => contribution.rows),
    ).toContainEqual({
      scope: { kind: "private-overlay", workspaceId: removed },
      value: false,
      source: "Control store",
      diagnostic: {
        _tag: "dangling",
        source: "Control store",
        detail: "No loaded MCP server has this identity.",
      },
    });
  });

  it("keeps a catalog query failure visible", () => {
    const cause = Cause.fail(new Error("catalog unreadable"));
    const failed = AsyncResult.failure<PluginOverview, Error>(cause);

    expect(pluginOverviewOf(null, failed)).toEqual({ plugins: [] });
    expect(pluginQueryFailure(failed)).toBe(cause);
  });

  it("uses the latest live Plugin event after a mutation", () => {
    const queried = AsyncResult.success(overview);
    const live = {
      ...initialBoard,
      plugins: { plugins: [] },
      pluginNotices: ["GitHub remains connected."],
    };

    expect(pluginSurfaceOf(live, queried)).toEqual({
      overview: { plugins: [] },
      notices: ["GitHub remains connected."],
      loadState: "ready",
    });
  });

  it("stays loading until Plugin data settles", () => {
    expect(pluginSurfaceOf(null, AsyncResult.initial()).loadState).toBe("loading");
  });

  it("keeps a deep-linked Plugin route while data loads", () => {
    expect(pluginDetailOf([], "linear", "loading")).toEqual({ _tag: "Loading" });
    expect(pluginDetailOf([], "linear", "ready")).toEqual({ _tag: "Missing" });
  });
});
