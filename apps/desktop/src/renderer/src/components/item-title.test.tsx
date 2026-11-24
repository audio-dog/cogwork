import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ItemTitle } from "./item-tab";

const title = "Link the tracker item";
const renderTitle = (url: string | null) => renderToStaticMarkup(<ItemTitle title={title} url={url} />);

describe("ItemTitle", () => {
  it("links the main item title to its tracker item", () => {
    const markup = renderTitle("https://linear.app/acme/issue/AUD-1");

    expect(markup).toContain(
      '<a href="https://linear.app/acme/issue/AUD-1" rel="noreferrer" target="_blank">Link the tracker item</a>',
    );
  });

  it("renders a plain title when the tracker URL is unavailable", () => {
    const markup = renderTitle(null);

    expect(markup).toContain(title);
    expect(markup).not.toContain("<a ");
  });
});
