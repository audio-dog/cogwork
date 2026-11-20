import { TooltipProvider } from "@cogwork/ui/components/tooltip";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { type Contribution, McpReadiness } from "../features/configuration-model";
import { contributionById, placeholderConfiguration } from "../testing/configuration";
import { Configuration } from "./configuration-provider";
import { CustomizeFilterProvider } from "./customize-filter";
import { McpFacet } from "./mcp-facet";

const disabledDisconnectedServer = () => {
  const contribution = contributionById("plugin:linear/mcp/linear");
  if (!contribution) throw new Error("fixture is missing linear MCP");
  return {
    ...contribution,
    readiness: McpReadiness["not-ready"]({ reason: "Connection needed" }),
    rows: [{ scope: { kind: "settings-profile" }, value: false, source: "Control store" }],
  } satisfies Contribution;
};

describe("McpFacet", () => {
  it("keeps a disabled disconnected server out of Needs Attention", () => {
    const picture = { ...placeholderConfiguration, contributions: [disabledDisconnectedServer()] };
    const markup = renderToStaticMarkup(
      <Configuration.Provider picture={picture}>
        <CustomizeFilterProvider>
          <TooltipProvider>
            <McpFacet />
          </TooltipProvider>
        </CustomizeFilterProvider>
      </Configuration.Provider>,
    );

    expect(markup).not.toContain("Needs Attention");
    expect(markup).toContain("Ready");
    expect(markup).toContain("Disabled");
  });
});
