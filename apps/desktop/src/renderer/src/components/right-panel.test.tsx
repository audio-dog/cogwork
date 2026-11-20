import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";

import { useRightPanelStore } from "../store/right-panel";
import { RightPanel } from "./right-panel";

const reset = () =>
  useRightPanelStore.setState({
    open: false,
    maximized: false,
    surfaces: [],
    active: null,
  });

describe("RightPanel", () => {
  beforeEach(reset);

  it("renders the tab strip in store order", () => {
    const { openTool } = useRightPanelStore.getState();
    openTool("attention");
    openTool("terminal");

    const markup = renderToStaticMarkup(<RightPanel />);

    expect(markup.indexOf("Attention")).toBeLessThan(markup.indexOf("Terminal"));
  });
});
