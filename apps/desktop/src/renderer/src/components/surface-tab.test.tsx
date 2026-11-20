import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SurfaceTab } from "./surface-tab";

describe("SurfaceTab", () => {
  it("forwards trigger props to its tab button", () => {
    const markup = renderToStaticMarkup(
      <SurfaceTab.Button aria-describedby="item-workspace" onClick={() => undefined}>
        Item
      </SurfaceTab.Button>,
    );

    expect(markup).toContain('aria-describedby="item-workspace"');
  });
});
