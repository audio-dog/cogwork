import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { PluginOverview, pluginContributionId } from "./plugin";

describe("Plugin contract", () => {
  it("qualifies MCP server identities with the Plugin authority", () => {
    assert.strictEqual(pluginContributionId("linear", "mcp-server", "linear"), "plugin:linear/mcp/linear");
  });

  it("decodes Catalog, installed, and failed contribution rows in one overview", () => {
    const overview = Schema.decodeSync(PluginOverview)({
      plugins: [
        {
          pluginId: "linear",
          name: "Linear",
          summary: "Linear tools",
          record: null,
          resolvedIdentity: "linear@1.0.0",
          requiredConnections: ["linear"],
          manifestFailure: null,
          contributions: [
            {
              id: "plugin:linear/mcp/linear",
              authority: "plugin:linear",
              kind: "mcp-server",
              localName: "linear",
              summary: "Linear MCP server",
              file: "/plugins/linear/mcp/linear.json",
              load: { _tag: "Failed", reason: "invalid JSON" },
            },
          ],
        },
      ],
    });

    assert.strictEqual(overview.plugins[0]?.contributions[0]?.load._tag, "Failed");
  });
});
