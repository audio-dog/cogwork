import { assert, describe, it } from "@effect/vitest";
import { boardMissing, type PriorityRepo, type ProjectPrioritiesPayload, pageOf } from "./priority";

const repo: PriorityRepo = { owner: "owner", name: "repo" };

const payload = (
  nodes: ReadonlyArray<{
    readonly number?: number;
    readonly isIssue?: boolean;
    readonly isNull?: boolean;
    readonly name?: string;
    readonly hasField?: boolean;
    readonly owner?: string;
    readonly repository?: string;
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
        nodes: nodes.map((node) =>
          node.isNull
            ? null
            : {
                content:
                  node.isIssue === false
                    ? null
                    : {
                        number: node.number,
                        repository: {
                          name: node.repository ?? repo.name,
                          owner: { login: node.owner ?? repo.owner },
                        },
                      },
                fieldValueByName: node.hasField === false ? null : { name: node.name },
              },
        ),
      },
    },
  },
});

describe("boardMissing", () => {
  it("is true when the owner or project is absent from a successful GraphQL body", () => {
    assert.strictEqual(boardMissing({ repositoryOwner: null }), true);
    assert.strictEqual(boardMissing({ repositoryOwner: { projectV2: null } }), true);
    assert.strictEqual(boardMissing(payload([])), false);
  });
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
      repo,
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
      repo,
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
      repo,
    );
    assert.deepStrictEqual([...page.entries], [[5, "high"]]);
  });

  it("skips cards from another repository so issue numbers cannot collide", () => {
    const page = pageOf(
      payload([
        { number: 5, name: "Urgent", owner: "other", repository: "repo" },
        { number: 5, name: "Low", owner: "owner", repository: "other" },
        { number: 5, name: "High" },
      ]),
      repo,
    );
    assert.deepStrictEqual([...page.entries], [[5, "high"]]);
  });

  it("matches repository owner and name case-insensitively", () => {
    const page = pageOf(payload([{ number: 7, name: "Urgent", owner: "Owner", repository: "Repo" }]), repo);
    assert.deepStrictEqual([...page.entries], [[7, "urgent"]]);
  });

  it("skips null nodes from inaccessible board cards", () => {
    const page = pageOf(payload([{ isNull: true }, { number: 5, name: "High" }]), repo);
    assert.deepStrictEqual([...page.entries], [[5, "high"]]);
  });

  it("reports the next cursor only while more pages remain", () => {
    assert.strictEqual(pageOf(payload([], { hasNextPage: true, endCursor: "abc" }), repo).nextCursor, "abc");
    assert.strictEqual(pageOf(payload([], { hasNextPage: false, endCursor: "abc" }), repo).nextCursor, null);
  });

  it("returns nothing when the owner or board is absent", () => {
    assert.deepStrictEqual([...pageOf({ repositoryOwner: null }, repo).entries], []);
    assert.deepStrictEqual([...pageOf({ repositoryOwner: { projectV2: null } }, repo).entries], []);
  });
});
