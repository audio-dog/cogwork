import { expect, it } from "vitest";

export const buildItem = (title: string) => ({ title });

it("keeps the title", () => {
  expect(buildItem("Fix the build").title).toBe("Fix the build");
});
