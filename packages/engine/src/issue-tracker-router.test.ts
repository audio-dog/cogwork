import { GitHubIssueFieldId, WorkItemId, WorkspaceConfig } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { GitHubClient, type RawIssue } from "./github/client";
import { IssueTracker } from "./issue-tracker";
import { routedLayer } from "./issue-tracker-router";
import { LinearClient } from "./linear/client";
import type { RegisteredWorkspace } from "./projector";
import { readOnlyRegistry, WorkspaceRegistry } from "./registry";
import { WorkflowArtifactStore } from "./workflow-artifact-store";

const id = Schema.decodeSync(WorkItemId);

const workspaceOf = (
  name: string,
  issueTracker: (typeof WorkspaceConfig.Encoded)["issueTracker"],
  repository?: string,
): RegisteredWorkspace => ({
  source: `${name}.workspace.ts`,
  contributions: [],
  ...(repository ? { repository } : {}),
  config: Schema.decodeSync(WorkspaceConfig)({ name, checkoutPath: `/repos/${name}`, issueTracker }),
});

const githubWorkspace = workspaceOf("gh", { type: "github", priority: { field: 42 } }, "acme/example");
const linearWorkspace = workspaceOf("lin", { type: "linear", teams: ["AUD"] });

const githubIssue = (number: number, isPullRequest = false): RawIssue => ({
  nodeId: `node-${number}`,
  number,
  title: `Login bug ${number}`,
  url: `https://github.com/acme/example/issues/${number}`,
  labels: ["needs-triage"],
  assignees: ["maintainer"],
  isPullRequest,
  openBlockers: 0,
  body: `Body ${number}`,
  state: "open",
  createdAtMillis: 1_000,
  updatedAtMillis: 2_000,
});

const githubClient = Layer.mock(GitHubClient, {
  listIssues: (_repo, query) =>
    Effect.succeed(query?.since === 5_000 ? [githubIssue(3)] : [githubIssue(1), githubIssue(2, true)]),
  listIssueEvents: () =>
    Effect.succeed([
      { id: 1, event: "labeled", labelName: "needs-triage", createdAtMillis: 1_100 },
      { id: 2, event: "labeled", labelName: "ready-for-agent", createdAtMillis: 1_200 },
      { id: 3, event: "labeled", labelName: "needs-triage", createdAtMillis: 1_300 },
    ]),
  listTriggerComments: () =>
    Effect.succeed([
      {
        id: 10,
        authorLogin: "person",
        authorAssociation: "MEMBER",
        authorType: "User",
        body: "Over the limit",
        createdAtMillis: 1_600,
      },
    ]),
  listLabels: () => Effect.succeed(["needs-triage", "ready-for-agent"]),
  readIssue: (_repo, number) => Effect.succeed(githubIssue(number)),
  listAllComments: () =>
    Effect.succeed([
      {
        id: 9,
        authorLogin: "person",
        authorAssociation: "MEMBER",
        body: "Same as #4",
        createdAtMillis: 1_500,
      },
    ]),
  listPriorityFields: () =>
    Effect.succeed([{ id: Schema.decodeSync(GitHubIssueFieldId)(42), name: "Priority" }]),
  listIssueFieldValues: () => Effect.succeed(new Map([[1, new Map([[42, "Urgent"]])]])),
});

const linearClient = Layer.mock(LinearClient, {
  observeIssues: (_ref, _coordination, _assignees, updatedSince) =>
    Effect.succeed([
      {
        id: "linear-id",
        identifier: "AUD-7",
        title: "Audit export",
        url: "https://linear.app/acme/issue/AUD-7",
        labels: ["needs-triage"],
        assignees: ["owner"],
        stateName: "Todo",
        stateType: "unstarted",
        openBlockers: 1,
        priority: "high",
        updatedAtMillis: 3_000,
        createdAtMillis: updatedSince ?? 2_500,
        coordinationComments: [],
      },
    ]),
  readProse: () =>
    Effect.succeed({
      body: "Linear body",
      comments: [
        { id: "c", authorId: "owner", authorAssociation: "MEMBER", body: "note", createdAtMillis: 4 },
      ],
    }),
  issueAssignees: () => Effect.succeed(["owner"]),
  labelAppliedAt: (_ref, _issue, label) => Effect.succeed(label === "needs-triage" ? 3_500 : null),
  readTriggerProse: () =>
    Effect.succeed({
      body: "Linear body",
      comments: [
        { id: "c", authorId: "owner", authorAssociation: "MEMBER", body: "note", createdAtMillis: 4 },
        { id: "d", authorId: "guest", authorAssociation: "NONE", body: "hi", createdAtMillis: 5 },
      ],
    }),
  listLabels: () => Effect.succeed(["needs-triage"]),
});

const trackerLayer = routedLayer.pipe(
  Layer.provide([
    githubClient,
    linearClient,
    Layer.succeed(
      WorkspaceRegistry,
      readOnlyRegistry({ workspaces: [githubWorkspace, linearWorkspace], failures: [] }),
    ),
    Layer.mock(WorkflowArtifactStore, {}),
  ]),
);

describe("routed issue tracker reads", () => {
  it.effect("observes open GitHub issues with the configured priority field", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTracker;
      const items = yield* tracker.observe(githubWorkspace);
      assert.deepStrictEqual(
        items.map(({ id, title, assignees, priority, states }) => ({
          id,
          title,
          assignees,
          priority,
          states,
        })),
        [
          {
            id: id("#1"),
            title: "Login bug 1",
            assignees: ["maintainer"],
            priority: "urgent",
            states: ["needs-triage"],
          },
        ],
      );
    }).pipe(Effect.provide(trackerLayer)),
  );

  it.effect("reads GitHub prose and assignees for one issue", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTracker;
      const prose = yield* tracker.readProse(githubWorkspace, id("#1"));
      const assignees = yield* tracker.assignees?.(githubWorkspace, id("#1")) ?? Effect.succeed([]);
      assert.strictEqual(prose.body, "Body 1");
      assert.deepStrictEqual(
        prose.comments.map(({ author, body }) => ({ author, body })),
        [{ author: "person", body: "Same as #4" }],
      );
      assert.deepStrictEqual(assignees, ["maintainer"]);
    }).pipe(Effect.provide(trackerLayer)),
  );

  it.effect("observes Linear issues and reads their prose and assignees", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTracker;
      const items = yield* tracker.observe(linearWorkspace);
      const prose = yield* tracker.readProse(linearWorkspace, id("AUD-7"));
      const assignees = yield* tracker.assignees?.(linearWorkspace, id("AUD-7")) ?? Effect.succeed([]);
      assert.deepStrictEqual(
        items.map(({ id, priority, openBlockers, states }) => ({ id, priority, openBlockers, states })),
        [{ id: id("AUD-7"), priority: "high", openBlockers: 1, states: ["needs-triage", "Todo"] }],
      );
      assert.strictEqual(prose.body, "Linear body");
      assert.deepStrictEqual(assignees, ["owner"]);
    }).pipe(Effect.provide(trackerLayer)),
  );

  it.effect("lists GitHub issues changed since a cursor through the observe listing", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTracker;
      const observed = yield* tracker.observe(githubWorkspace);
      const changed = yield* tracker.itemsChangedSince(githubWorkspace, 5_000);
      assert.deepStrictEqual(
        observed.map(({ id, lastTouchedAtMillis }) => ({ id, lastTouchedAtMillis })),
        [{ id: id("#1"), lastTouchedAtMillis: 2_000 }],
      );
      assert.deepStrictEqual(changed, [
        {
          id: id("#3"),
          title: "Login bug 3",
          url: "https://github.com/acme/example/issues/3",
          assignees: ["maintainer"],
          openBlockers: 0,
          priority: "medium",
          states: ["needs-triage"],
          open: true,
          labels: ["needs-triage"],
          createdAtMillis: 1_000,
          lastTouchedAtMillis: 2_000,
        },
      ]);
    }).pipe(Effect.provide(trackerLayer)),
  );

  it.effect("reads GitHub label history, trigger prose, and labels", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTracker;
      const appliedAt = yield* tracker.labelAppliedAt(githubWorkspace, id("#1"), "needs-triage");
      const neverApplied = yield* tracker.labelAppliedAt(githubWorkspace, id("#1"), "wontfix");
      const prose = yield* tracker.readTriggerProse(githubWorkspace, id("#1"));
      const labels = yield* tracker.listLabels(githubWorkspace);
      assert.strictEqual(appliedAt, 1_300);
      assert.isNull(neverApplied);
      assert.deepStrictEqual(prose, {
        body: "Body 1",
        comments: [
          {
            id: "10",
            author: "person",
            authorAssociation: "MEMBER",
            authoredByPerson: true,
            body: "Over the limit",
            createdAtMillis: 1_600,
          },
        ],
      });
      assert.deepStrictEqual(labels, ["needs-triage", "ready-for-agent"]);
    }).pipe(Effect.provide(trackerLayer)),
  );

  it.effect("lists Linear issues changed since a cursor and reads label history, prose, and labels", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTracker;
      const changed = yield* tracker.itemsChangedSince(linearWorkspace, 3_000);
      const appliedAt = yield* tracker.labelAppliedAt(linearWorkspace, id("AUD-7"), "needs-triage");
      const prose = yield* tracker.readTriggerProse(linearWorkspace, id("AUD-7"));
      const labels = yield* tracker.listLabels(linearWorkspace);
      assert.deepStrictEqual(changed, [
        {
          id: id("AUD-7"),
          title: "Audit export",
          url: "https://linear.app/acme/issue/AUD-7",
          assignees: ["owner"],
          openBlockers: 1,
          priority: "high",
          states: ["needs-triage", "Todo"],
          open: true,
          labels: ["needs-triage"],
          createdAtMillis: 3_000,
          lastTouchedAtMillis: 3_000,
        },
      ]);
      assert.strictEqual(appliedAt, 3_500);
      assert.deepStrictEqual(
        prose.comments.map(({ id, authoredByPerson }) => ({ id, authoredByPerson })),
        [
          { id: "c", authoredByPerson: true },
          { id: "d", authoredByPerson: false },
        ],
      );
      assert.deepStrictEqual(labels, ["needs-triage"]);
    }).pipe(Effect.provide(trackerLayer)),
  );
});
