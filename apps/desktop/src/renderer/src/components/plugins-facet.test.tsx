import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { placeholderConfiguration } from "../features/configuration-placeholder";
import { Configuration } from "./configuration-provider";
import { CustomizeFilterProvider } from "./customize-filter";
import { PluginsFacet } from "./plugins-facet";

describe("PluginsFacet", () => {
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
});
