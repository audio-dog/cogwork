import { defaultControlStore, localOwnerId, type PluginOverview } from "@cogwork/contracts";
import * as Cause from "effect/Cause";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { describe, expect, it } from "vitest";
import { placeholderConfiguration } from "./configuration-placeholder";
import { configurationWithPlugins, pluginOverviewOf, pluginQueryFailure } from "./plugin-configuration";

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
          contribution: "plugin:linear/mcp/linear",
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

  it("keeps a catalog query failure visible", () => {
    const cause = Cause.fail(new Error("catalog unreadable"));
    const failed = AsyncResult.failure<PluginOverview, Error>(cause);

    expect(pluginOverviewOf(null, failed)).toEqual({ plugins: [] });
    expect(pluginQueryFailure(failed)).toBe(cause);
  });
});
