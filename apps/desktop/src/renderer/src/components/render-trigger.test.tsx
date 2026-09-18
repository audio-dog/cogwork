import { TooltipProvider } from "@cogwork/ui/components/tooltip";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  contributionById,
  placeholderConfiguration,
  StaticConfigurationProvider,
} from "../testing/configuration";
import { CustomizeFilterProvider } from "./customize-filter";
import { CustomizePlaceMenu } from "./customize-place-menu";
import { McpServerRow } from "./mcp-server-row";

/**
 * Base UI hosts a custom component through `render` by handing it the ref, the click handler and
 * the ARIA wiring as props. A component that destructures only what it names swallows them, and the
 * control silently stops working — it still looks right, so only the wiring gives it away.
 */
function render(node: ReactElement) {
  return renderToStaticMarkup(
    <StaticConfigurationProvider picture={placeholderConfiguration}>
      <TooltipProvider>
        <CustomizeFilterProvider>{node}</CustomizeFilterProvider>
      </TooltipProvider>
    </StaticConfigurationProvider>,
  );
}

/** The opening tag of the nth `<button>`, minus its class list — Tailwind names variants after
 * these very attributes, so leaving the classes in makes every assertion pass. */
function buttonTag(markup: string, index = 0) {
  const tags = [...markup.matchAll(/<button[^>]*>/g)].map((match) => match[0]);
  const tag = tags[index];
  if (!tag) throw new Error(`no button at index ${index}`);
  return tag.replace(/class="[^"]*"/, "");
}

describe("a trigger hosted through `render` keeps the props it is given", () => {
  it("wires the Place menu's trigger to its popover", () => {
    const tag = buttonTag(render(<CustomizePlaceMenu kind="skill" />));
    expect(tag).toContain('data-slot="popover-trigger"');
    expect(tag).toContain('aria-haspopup="dialog"');
    expect(tag).toContain("aria-expanded");
  });

  it("keeps the row's own marker when a host overwrites data-slot", () => {
    const contribution = contributionById("plugin:linear/mcp/linear");
    if (!contribution) throw new Error("fixture is missing the MCP server");

    const tag = buttonTag(render(<McpServerRow contribution={contribution} />));
    expect(tag).toContain("data-list-row-open");
    expect(tag).toContain('data-slot="dialog-trigger"');
    expect(tag).toContain("aria-haspopup");
  });
});
