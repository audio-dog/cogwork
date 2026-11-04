import { WorkItemId, WorkspaceConfig, WorkspaceId } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type { WorkspaceIssueTrackerBinding } from "../projector";
import { GitHubClient, type RawIssue } from "./client";
import { makeIssueActions } from "./host";

const workspace: WorkspaceIssueTrackerBinding = {
  repository: "acme/example",
  config: Schema.decodeSync(WorkspaceConfig)({
    name: Schema.decodeSync(WorkspaceId)("github-workspace"),
    checkoutPath: "/repos/example",
    issueTracker: { type: "github" },
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
