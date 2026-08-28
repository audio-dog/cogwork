import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ConfigurationPicture, InstalledPlugin } from "../features/configuration-model";
import { placeholderConfiguration } from "../features/configuration-placeholder";
import { Configuration } from "./configuration-provider";
import { PluginDetail } from "./plugin-detail";

const plugin: InstalledPlugin = {
  record: {
    pluginId: "linear",
    resolvedIdentity: "linear@1.0.0",
    principal: "local-owner",
    installedAt: "2026-08-28T00:00:00.000Z",
  },
  name: "Linear",
  summary: "Linear tools",
  manifestFailure: null,
  contributionIds: [],
  permissions: [],
  requiredConnections: [],
  setup: [],
};

const picture: ConfigurationPicture = {
  ...placeholderConfiguration,
  plugins: [plugin],
  catalogPlugins: [],
  contributions: placeholderConfiguration.contributions.filter(
    (contribution) => contribution.authority._tag !== "plugin",
  ),
};

describe("PluginDetail", () => {
  it("shows an uninstall failure on the current Plugin", () => {
    const router = createRouter({
      routeTree: createRootRoute(),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    const markup = renderToStaticMarkup(
      <RouterContextProvider router={router}>
        <Configuration.Provider picture={picture} pluginFailure="could not reclaim Plugin files">
          <PluginDetail plugin={plugin} />
        </Configuration.Provider>
      </RouterContextProvider>,
    );

    expect(markup).toContain("Plugin change failed");
    expect(markup).toContain("could not reclaim Plugin files");
  });
});
