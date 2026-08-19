import { assert, describe, it } from "@effect/vitest";
import { graphQlData } from "./client";

describe("graphQlData", () => {
  it("keeps partial data when errors accompany accessible cards", () => {
    const result = graphQlData({ data: { repositoryOwner: {} }, errors: [{ message: "FORBIDDEN" }] });
    assert.strictEqual(result.ok, true);
    if (result.ok) assert.deepStrictEqual(result.data, { repositoryOwner: {} });
  });

  it("fails when errors arrive without data", () => {
    const result = graphQlData({ errors: [{ message: "bad scope" }] });
    assert.strictEqual(result.ok, false);
    if (!result.ok) assert.match(result.message, /bad scope/);
  });
});
