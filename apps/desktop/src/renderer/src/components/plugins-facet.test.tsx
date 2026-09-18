import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Authority, type ConfigurationPicture, type InstalledPlugin } from "../features/configuration-model";
import { placeholderConfiguration } from "../testing/configuration";
import { Configuration, PluginFailurePresentation } from "./configuration-provider";
import { CustomizeFilterProvider } from "./customize-filter";
import { PluginsFacet } from "./plugins-facet";

describe("PluginsFacet", () => {
  const emptyPicture: ConfigurationPicture = {
    ...placeholderConfiguration,
    plugins: [],
    catalogPlugins: [],
    contributions: placeholderConfiguration.contributions.filter(
      (contribution) => !Authority.$is("plugin")(contribution.authority),
    ),
  };

  const attentionPlugin: InstalledPlugin = {
    record: {
      pluginId: "linear",
      resolvedIdentity: "linear@1.0.0",
      principal: "local-owner",
      installedAt: "2026-08-28T00:00:00.000Z",
    },
    name: "Linear",
    summary: "Linear tools",
    manifestFailure: "plugin.json is invalid",
    contributionIds: [],
    permissions: [],
    requiredConnections: [],
    setup: [],
  };

  it("points an empty Installed section to the Catalog", () => {
    const picture = {
      ...placeholderConfiguration,
      plugins: [],
      catalogPlugins: [
        {
          pluginId: "github",
          name: "GitHub",
          summary: "GitHub tools",
          resolvedIdentity: "github@1.0.0",
          manifestFailure: null,
        },
      ],
    };
    const markup = renderToStaticMarkup(
      <Configuration.Provider picture={picture}>
        <CustomizeFilterProvider>
          <PluginsFacet />
        </CustomizeFilterProvider>
      </Configuration.Provider>,
    );

    expect(markup).toContain("GitHub");
    expect(markup).toContain("No Plugins installed");
    expect(markup).toContain("Install one from the Catalog below.");
    expect(markup).not.toContain("Everything&#x27;s in the list above.");
  });

  it("shows loading before an empty Plugins result", () => {
    const markup = renderToStaticMarkup(
      <Configuration.Provider picture={emptyPicture} pluginLoadState="loading">
        <CustomizeFilterProvider>
          <PluginsFacet />
        </CustomizeFilterProvider>
      </Configuration.Provider>,
    );

    expect(markup).toContain("Loading Plugins");
    expect(markup).not.toContain("No Plugins yet");
  });

  it("shows a load failure before an empty Plugins result", () => {
    const markup = renderToStaticMarkup(
      <Configuration.Provider
        picture={emptyPicture}
        pluginFailure={PluginFailurePresentation.Load({ message: "catalog unreadable" })}
        pluginLoadState="failed"
      >
        <CustomizeFilterProvider>
          <PluginsFacet />
        </CustomizeFilterProvider>
      </Configuration.Provider>,
    );

    expect(markup).toContain("Plugins failed to load");
    expect(markup).toContain("catalog unreadable");
    expect(markup).not.toContain("Plugin change failed");
    expect(markup).not.toContain("No Plugins yet");
  });

  it("does not claim no Plugins are installed when one needs attention", () => {
    const router = createRouter({
      routeTree: createRootRoute(),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    const markup = renderToStaticMarkup(
      <RouterContextProvider router={router}>
        <Configuration.Provider picture={{ ...emptyPicture, plugins: [attentionPlugin] }}>
          <CustomizeFilterProvider>
            <PluginsFacet />
          </CustomizeFilterProvider>
        </Configuration.Provider>
      </RouterContextProvider>,
    );

    expect(markup).toContain("All installed Plugins need attention");
    expect(markup).not.toContain("No Plugins installed");
  });
});
