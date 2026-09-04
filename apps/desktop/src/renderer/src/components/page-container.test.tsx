import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PageContainer } from "./page-container";

describe("PageContainer", () => {
  it.each([
    ["readable", "max-w-2xl"],
    ["standard", "max-w-3xl"],
    ["wide", "max-w-5xl"],
  ] as const)("frames %s pages", (width, expectedClass) => {
    const markup = renderToStaticMarkup(<PageContainer width={width}>Page</PageContainer>);

    expect(markup).toContain("mx-auto w-full");
    expect(markup).toContain("px-8");
    expect(markup).toContain("pb-12");
    expect(markup).toContain(expectedClass);
  });

  it("composes page-specific layout", () => {
    const markup = renderToStaticMarkup(
      <PageContainer width="wide" className="flex pt-6">
        Page
      </PageContainer>,
    );

    expect(markup).toContain("flex");
    expect(markup).toContain("pt-6");
  });
});
