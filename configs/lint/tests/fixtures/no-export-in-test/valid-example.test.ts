import { expect, it } from "vitest";

import { makeWorkItem } from "./work-item-fixtures.ts";

const titleOf = (title: string) => makeWorkItem(title).title;

it("keeps the title", () => {
  expect(titleOf("a")).toBe("a");
});
