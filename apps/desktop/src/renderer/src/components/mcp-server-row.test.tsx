import { TooltipProvider } from "@cogwork/ui/components/tooltip";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { type Contribution, McpReadiness } from "../features/configuration-model";
import {
  contributionById,
  placeholderConfiguration,
  StaticConfigurationProvider,
} from "../testing/configuration";
import { McpServerRow } from "./mcp-server-row";

function required(id: string) {
  const contribution = contributionById(id);
  if (!contribution) throw new Error(`fixture is missing ${id}`);
  return contribution;
}

function renderContribution(contribution: Contribution) {
  return renderToStaticMarkup(
    <StaticConfigurationProvider picture={placeholderConfiguration}>
      <TooltipProvider>
        <McpServerRow contribution={contribution} />
      </TooltipProvider>
    </StaticConfigurationProvider>,
  );
}

function render(id: string) {
  return renderContribution(required(id));
}

function buttonDepth(markup: string) {
  return [...markup.matchAll(/<button\b|<\/button>/g)].reduce(
    (state, token) => {
      const depth = state.depth + (token[0] === "</button>" ? -1 : 1);
      return { depth, deepest: Math.max(state.deepest, depth) };
    },
    { depth: 0, deepest: 0 },
  ).deepest;
}

describe("McpServerRow", () => {
  it("never nests the switch inside the row's own button", () => {
    const markup = render("plugin:linear/mcp/linear");
    expect(buttonDepth(markup)).toBe(1);
  });

  it("gives the row's open control a name of its own", () => {
    expect(render("plugin:linear/mcp/linear")).toContain("Configure linear");
  });

  it("shows an overlay diagnostic on a machine-level server", () => {
    expect(render("plugin:granola/mcp/granola")).toContain("Dangling");
  });

  it("renders a repository offer as a muted Disabled row", () => {
    const markup = render("local:repo/mcp/repo-tools");
    expect(markup).toContain("Disabled");
    expect(markup).toContain("opacity-60");
  });

  it("renders a disabled disconnected server as off without error status", () => {
    const contribution = {
      ...required("plugin:linear/mcp/linear"),
      readiness: McpReadiness["not-ready"]({ reason: "Connection needed" }),
      rows: [{ scope: { kind: "settings-profile" }, value: false, source: "Control store" }],
    } satisfies Contribution;

    const markup = renderContribution(contribution);

    expect(markup).toContain("Disabled");
    expect(markup).toContain("Off · User");
    expect(markup).not.toContain("Connection needed");
    expect(markup).not.toContain("bg-destructive");
  });
});
