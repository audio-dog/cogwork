import { WorkItemId, WorkspaceConfig, WorkspaceId } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type { WorkspaceIssueTrackerBinding } from "../projector";
import { GitHubClient, type RawIssue, type RawIssueComment } from "./client";
import { makeIssueActions, makeIssueReads } from "./host";
import { wireCodec } from "./markers";

const workspace: WorkspaceIssueTrackerBinding = {
  repository: "acme/example",
  config: Schema.decodeSync(WorkspaceConfig)({
    name: Schema.decodeSync(WorkspaceId)("github-workspace"),
    checkoutPath: "/repos/example",
    issueTracker: { type: "github" },
  }),
};
const allowlistedWorkspace: WorkspaceIssueTrackerBinding = {
  repository: "acme/example",
  config: Schema.decodeSync(WorkspaceConfig)({
    name: Schema.decodeSync(WorkspaceId)("github-workspace"),
    checkoutPath: "/repos/example",
    issueTracker: { type: "github" },
    sourceControl: { type: "github", botAllowlist: ["release-bot"] },
  }),
};
const issueId = Schema.decodeSync(WorkItemId)("#7");

const issue = (labels: ReadonlyArray<string>): RawIssue => ({
  nodeId: "issue-7",
  number: 7,
  title: "Fix login",
  url: "https://github.com/acme/example/issues/7",
  labels,
  assignees: [],
  isPullRequest: false,
  openBlockers: 0,
  body: "",
  state: "open",
  createdAtMillis: 0,
});

const trackerWith = Effect.fn("GitHubHostTest.trackerWith")(function* (
  initial: ReadonlyArray<string>,
  options: { readonly dropLabelWrites?: boolean } = {},
) {
  const labels = yield* Ref.make(initial);
  const comments = yield* Ref.make<ReadonlyArray<string>>([]);
  const client = yield* GitHubClient.pipe(
    Effect.provide(
      Layer.mock(GitHubClient, {
        readIssue: () => Effect.map(Ref.get(labels), issue),
        addLabel: (_repo, _number, label) =>
          options.dropLabelWrites ? Effect.void : Ref.update(labels, (current) => [...current, label]),
        removeLabel: (_repo, _number, label) =>
          Ref.update(labels, (current) => current.filter((candidate) => candidate !== label)),
        createComment: (_repo, _number, body) =>
          Ref.update(comments, (current) => [...current, body]).pipe(Effect.map(() => ({ id: 1 }))),
      }),
    ),
  );
  return { actions: makeIssueActions(client), labels, comments };
});

describe("GitHub Workflow label writes", () => {
  it.effect("changes the labels and posts no comment", () =>
    Effect.gen(function* () {
      const { actions, labels, comments } = yield* trackerWith(["needs-triage"]);

      yield* actions.addLabels(workspace, issueId, ["wontfix"]);
      yield* actions.removeLabel(workspace, issueId, "needs-triage");
      yield* actions.removeLabel(workspace, issueId, "needs-info");

      assert.deepStrictEqual(yield* Ref.get(labels), ["wontfix"]);
      assert.deepStrictEqual(yield* Ref.get(comments), []);
    }),
  );

  it.effect("fails when the read-back does not show the label", () =>
    Effect.gen(function* () {
      const { actions } = yield* trackerWith([], { dropLabelWrites: true });

      const error = yield* Effect.flip(actions.addLabels(workspace, issueId, ["wontfix"]));

      assert.strictEqual(error.reason, "unavailable");
      assert.include(error.message, "not confirmed by read-back");
    }),
  );
});

describe("GitHub trigger prose", () => {
  it.effect("marks only a member's own comment as a person's", () =>
    Effect.gen(function* () {
      const comment = (
        id: number,
        authorLogin: string,
        authorAssociation: string,
        authorType: string,
      ): RawIssueComment => ({
        id,
        authorLogin,
        authorAssociation,
        authorType,
        body: "",
        createdAtMillis: id,
      });
      const client = yield* GitHubClient.pipe(
        Effect.provide(
          Layer.mock(GitHubClient, {
            readIssue: () => Effect.succeed(issue([])),
            listTriggerComments: () =>
              Effect.succeed([
                comment(1, "maintainer", "MEMBER", "User"),
                comment(2, "dependabot[bot]", "MEMBER", "Bot"),
                comment(3, "release-bot", "MEMBER", "User"),
                comment(4, "stranger", "NONE", "User"),
                {
                  ...comment(5, "maintainer", "MEMBER", "User"),
                  body: wireCodec.encode({ name: "agent-note", pairs: "" }),
                },
              ]),
          }),
        ),
      );

      const prose = yield* makeIssueReads(client).readTriggerProse(allowlistedWorkspace, issueId);

      assert.deepStrictEqual(
        prose.comments.map(({ author, authoredByPerson }) => ({ author, authoredByPerson })),
        [
          { author: "maintainer", authoredByPerson: true },
          { author: "dependabot[bot]", authoredByPerson: false },
          { author: "release-bot", authoredByPerson: false },
          { author: "stranger", authoredByPerson: false },
          { author: "maintainer", authoredByPerson: false },
        ],
      );
    }),
  );
});

describe("GitHub issue listing", () => {
  it.effect("asks GitHub for open issues since a cursor, when observing, and by label", () =>
    Effect.gen(function* () {
      const queries: Array<unknown> = [];
      const client = yield* GitHubClient.pipe(
        Effect.provide(
          Layer.mock(GitHubClient, {
            listIssues: (_repo, query) => {
              queries.push(query);
              return Effect.succeed([issue([])]);
            },
          }),
        ),
      );
      const reads = makeIssueReads(client);

      yield* reads.observe(workspace);
      yield* reads.openItemsChangedSince(workspace, 1);
      yield* reads.openItemsWithLabel(workspace, "needs-triage");

      assert.deepStrictEqual(queries, [
        { state: "open" },
        { state: "open", since: 1 },
        { state: "open", label: "needs-triage" },
      ]);
    }),
  );
});
