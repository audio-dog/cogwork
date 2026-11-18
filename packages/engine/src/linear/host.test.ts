import { WorkItemId, WorkspaceConfig } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { afterEach, vi } from "vitest";
import { CredentialStore } from "../credential-store";
import type { WorkspaceIssueTrackerBinding } from "../projector";
import { LinearClient, layer } from "./client";
import { makeIssueReads } from "./host";
import { wireCodec } from "./markers";

const workspace: WorkspaceIssueTrackerBinding = {
  config: Schema.decodeSync(WorkspaceConfig)({
    name: "linear-workspace",
    checkoutPath: "/repos/linear",
    issueTracker: { type: "linear", teams: ["AUD"] },
  }),
};

const issueId = Schema.decodeSync(WorkItemId)("AUD-7");

describe("Linear trigger prose", () => {
  it.effect("marks a comment with no steering association as not a person's", () =>
    Effect.gen(function* () {
      const client = yield* LinearClient.pipe(
        Effect.provide(
          Layer.mock(LinearClient, {
            readTriggerProse: () =>
              Effect.succeed({
                body: "",
                comments: [
                  { id: "a", authorId: "owner", authorAssociation: "OWNER", body: "", createdAtMillis: 1 },
                  { id: "b", authorId: "member", authorAssociation: "MEMBER", body: "", createdAtMillis: 2 },
                  { id: "c", authorId: "guest", authorAssociation: "NONE", body: "", createdAtMillis: 3 },
                  {
                    id: "d",
                    authorId: "member",
                    authorAssociation: "MEMBER",
                    body: wireCodec.encode({ name: "agent-note", pairs: "" }),
                    createdAtMillis: 4,
                  },
                ],
              }),
          }),
        ),
      );

      const prose = yield* makeIssueReads(client).readTriggerProse(workspace, issueId);

      assert.deepStrictEqual(
        prose.comments.map(({ author, authoredByPerson }) => ({ author, authoredByPerson })),
        [
          { author: "owner", authoredByPerson: true },
          { author: "member", authoredByPerson: true },
          { author: "guest", authoredByPerson: false },
          { author: "member", authoredByPerson: false },
        ],
      );
    }),
  );
});

const allowlistedWorkspace: WorkspaceIssueTrackerBinding = {
  config: Schema.decodeSync(WorkspaceConfig)({
    name: "linear-workspace",
    checkoutPath: "/repos/linear",
    issueTracker: { type: "linear", teams: ["AUD"], assigneeAllowlist: ["owner-id"] },
  }),
};

const emptyIssuePage = {
  data: { teams: { nodes: [{ issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } }] } },
};

const recordSentFilters = () => {
  const filters: Array<unknown> = [];
  vi.stubGlobal("fetch", (_input: unknown, init?: RequestInit) => {
    filters.push(JSON.parse(String(init?.body)).variables.filter);
    return Promise.resolve(Response.json(emptyIssuePage));
  });
  return filters;
};

const envCredentials = Layer.mock(CredentialStore, {
  bearerToken: () => Effect.succeed({ source: "env", token: Redacted.make("token"), identity: null }),
});

describe("Linear issue listing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.effect("asks Linear for open issues the allowlist owns on Trigger reads, and leaves observe wide", () =>
    Effect.gen(function* () {
      const filters = recordSentFilters();
      const reads = makeIssueReads(yield* LinearClient);
      const openOwned = {
        state: { type: { nin: ["completed", "canceled"] } },
        assignee: { id: { in: ["owner-id"] } },
      };

      yield* reads.openItemsChangedSince(allowlistedWorkspace, Date.UTC(2026, 10, 17));
      yield* reads.openItemsWithLabel(allowlistedWorkspace, "needs-triage");
      yield* reads.openItemsChangedSince(workspace, 0);
      yield* reads.observe(allowlistedWorkspace);

      assert.deepStrictEqual(filters, [
        { ...openOwned, updatedAt: { gte: "2026-11-17T00:00:00.000Z" } },
        { ...openOwned, labels: { name: { eq: "needs-triage" } } },
        {
          state: { type: { nin: ["completed", "canceled"] } },
          updatedAt: { gte: "1970-01-01T00:00:00.000Z" },
        },
        { state: { type: { nin: ["completed"] } } },
      ]);
    }).pipe(Effect.provide(Layer.provide(layer, envCredentials))),
  );
});
