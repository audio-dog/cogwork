import { assert, describe, it } from "@effect/vitest";
import { type ProjectPrioritiesPayload, pageOf } from "./priority";

const payload = (
  nodes: ReadonlyArray<{
    readonly number?: number;
    readonly isIssue?: boolean;
    readonly name?: string;
    readonly hasField?: boolean;
  }>,
  page: { readonly hasNextPage: boolean; readonly endCursor: string | null } = {
    hasNextPage: false,
    endCursor: null,
  },
): ProjectPrioritiesPayload => ({
  repositoryOwner: {
    projectV2: {
      items: {
        pageInfo: page,
        nodes: nodes.map((node) => ({
          content: node.isIssue === false ? null : { number: node.number },
          fieldValueByName: node.hasField === false ? null : { name: node.name },
        })),
      },
    },
  },
});

describe("pageOf", () => {
  it("maps the priority field value case-insensitively", () => {
    const page = pageOf(
      payload([
        { number: 1, name: "Urgent" },
        { number: 2, name: "high" },
        { number: 3, name: "MEDIUM" },
        { number: 4, name: "Low" },
      ]),
    );
    assert.deepStrictEqual(
      [...page.entries],
      [
        [1, "urgent"],
        [2, "high"],
        [3, "medium"],
        [4, "low"],
      ],
    );
  });

  it("resolves an unset or unrecognized field value to medium", () => {
    const page = pageOf(
      payload([
        { number: 1, hasField: false },
        { number: 2, name: undefined },
        { number: 3, name: "P0" },
      ]),
    );
    assert.deepStrictEqual(
      [...page.entries],
      [
        [1, "medium"],
        [2, "medium"],
        [3, "medium"],
      ],
    );
  });

  it("skips cards whose content is not an issue with a number", () => {
    const page = pageOf(
      payload([
        { isIssue: false, name: "Urgent" },
        { number: 5, name: "High" },
      ]),
    );
    assert.deepStrictEqual([...page.entries], [[5, "high"]]);
  });

  it("reports the next cursor only while more pages remain", () => {
    assert.strictEqual(pageOf(payload([], { hasNextPage: true, endCursor: "abc" })).nextCursor, "abc");
    assert.strictEqual(pageOf(payload([], { hasNextPage: false, endCursor: "abc" })).nextCursor, null);
  });

  it("returns nothing when the owner or board is absent", () => {
    assert.deepStrictEqual([...pageOf({ repositoryOwner: null }).entries], []);
    assert.deepStrictEqual([...pageOf({ repositoryOwner: { projectV2: null } }).entries], []);
  });
});
