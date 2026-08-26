import { TooltipProvider } from "@cogwork/ui/components/tooltip";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { contributionById, placeholderConfiguration } from "../features/configuration-placeholder";
import { Configuration } from "./configuration-provider";
import { McpServerRow } from "./mcp-server-row";

function required(id: string) {
  const contribution = contributionById(id);
  if (!contribution) throw new Error(`fixture is missing ${id}`);
  return contribution;
}

function render(id: string) {
  return renderToStaticMarkup(
    <Configuration.Provider picture={placeholderConfiguration}>
      <TooltipProvider>
        <McpServerRow contribution={required(id)} />
      </TooltipProvider>
    </Configuration.Provider>,
  );
}

/** Greatest depth of nested `<button>` elements in the markup. */
function buttonDepth(markup: string) {
  let depth = 0;
  let deepest = 0;
  for (const token of markup.matchAll(/<button\b|<\/button>/g)) {
    depth += token[0] === "</button>" ? -1 : 1;
    deepest = Math.max(deepest, depth);
  }
  return deepest;
}

describe("McpServerRow", () => {
  it("never nests the switch inside the row's own button", () => {
    // HTML forbids a button inside a button, and a screen reader flattens the switch when it
    // happens. The row opens from an overlay button that sits beside the controls, not around them.
    const markup = render("plugin:linear/mcp/linear");
    expect(buttonDepth(markup)).toBe(1);
  });

  it("gives the row's open control a name of its own", () => {
    expect(render("plugin:linear/mcp/linear")).toContain("Configure linear");
  });

  it("shows an overlay diagnostic on a machine-level server", () => {
    // Granola sits at the Settings profile and its only setting is a dangling one scoped to a
    // workspace. Resolving against its own view drops that row, so the badge must not depend on it.
    expect(render("plugin:granola/mcp/granola")).toContain("Dangling");
  });
});
