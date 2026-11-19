import { expect, it } from "vitest";

export const buildItem = (title: string) => ({ title });
export * from "vitest";
export { expect };
export default buildItem;

it("keeps the title", () => {
  expect(buildItem("Fix the build").title).toBe("Fix the build");
});
