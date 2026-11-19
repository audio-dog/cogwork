import { assert, describe, it } from "@effect/vitest";
import {
  closingReferencesFor,
  closingReferencesQuery,
  graphQlData,
  issuePullReferencesPage,
  issuePullReferencesQuery,
} from "./client-graphql";

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

describe("closingReferencesFor", () => {
  const repo = { owner: "owner", name: "repo", tokenEnv: "GITHUB_TOKEN" };

  it("queries closing references and keeps only references to the configured repository", () => {
    assert.include(closingReferencesQuery, "closingIssuesReferences");
    assert.include(closingReferencesQuery, "pageInfo");
    assert.deepStrictEqual(
      closingReferencesFor(repo, {
        repository: {
          pullRequests: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                number: 7,
                closingIssuesReferences: {
                  nodes: [
                    { number: 13, repository: { nameWithOwner: "OWNER/REPO" } },
                    { number: 13, repository: { nameWithOwner: "other/repo" } },
                  ],
                },
              },
            ],
          },
        },
      }),
      new Map([[7, [13]]]),
    );
  });
});

describe("issuePullReferencesPage", () => {
  it("reads pull request cross-references and the next cursor", () => {
    assert.include(issuePullReferencesQuery, "CROSS_REFERENCED_EVENT");
    assert.deepStrictEqual(
      issuePullReferencesPage({
        repository: {
          issue: {
            timelineItems: {
              pageInfo: { hasNextPage: true, endCursor: "next" },
              nodes: [
                {
                  source: {
                    body: "Refs #10",
                    merged: true,
                    repository: { nameWithOwner: "owner/repo" },
                  },
                },
                { source: {} },
              ],
            },
          },
        },
      }),
      {
        references: [{ body: "Refs #10", merged: true, repository: "owner/repo" }],
        nextCursor: "next",
      },
    );
  });
});
