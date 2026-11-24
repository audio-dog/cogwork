import { expect, it } from "vitest";

export const makeWorkItem = (title: string) => ({ title });

it("keeps the title", () => {
  expect(makeWorkItem("a").title).toBe("a");
});
