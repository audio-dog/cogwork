import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ListSectionRows } from "./customize-list";

const rows = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `row-${index}` }));

describe("ListSectionRows", () => {
  it("collapses past five and says how many are left", () => {
    const markup = renderToStaticMarkup(
      <ListSectionRows items={rows(7)} keyOf={(row) => row.id}>
        {(row) => <p>{row.id}</p>}
      </ListSectionRows>,
    );

    expect(markup).toContain("row-4");
    expect(markup).not.toContain("row-5");
    expect(markup).toContain("Show 2 more");
  });

  it("counts rows, not the nodes a row happens to render", () => {
    // The old version measured `children`, so a row made of two elements counted as two and a row
    // wrapped in a Fragment counted as one for the whole list.
    const markup = renderToStaticMarkup(
      <ListSectionRows items={rows(6)} keyOf={(row) => row.id}>
        {(row) => (
          <>
            <p>{row.id}</p>
            <span>trailing</span>
          </>
        )}
      </ListSectionRows>,
    );

    expect(markup).toContain("Show 1 more");
  });

  it("shows every row and no control when the list is short", () => {
    const markup = renderToStaticMarkup(
      <ListSectionRows items={rows(3)} keyOf={(row) => row.id}>
        {(row) => <p>{row.id}</p>}
      </ListSectionRows>,
    );

    expect(markup).toContain("row-2");
    expect(markup).not.toContain("Show");
  });

  it("renders a single row without a collapse control", () => {
    const markup = renderToStaticMarkup(
      <ListSectionRows items={rows(1)} keyOf={(row) => row.id}>
        {(row) => <p>{row.id}</p>}
      </ListSectionRows>,
    );

    expect(markup).toContain("row-0");
    expect(markup).not.toContain("Show");
  });
});
