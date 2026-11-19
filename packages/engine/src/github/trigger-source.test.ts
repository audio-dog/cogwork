import { keyOf, LineageId, RunId, WorkflowActionOrigin } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { vi } from "vitest";
import { matchTriggerEvent } from "../trigger-observation";
import { Recheck, type TriggerSubscription } from "../trigger-source";
import type { WorkflowArtifactStoreService } from "../workflow-artifact-store";
import { makeWorkflowOptions } from "../workflow-options";
import { GitHubClient, type GitHubClientService } from "./client";
import {
  firstIssueId,
  githubTrackerInstance,
  issue,
  issueHasLabelKey,
  issueNotBlockedKey,
  issueReads,
  newIssueCommentKey,
  prioritizedWorkspace,
  priorityFieldId,
  registryState,
  reviewTrigger,
  secondIssueId,
  subscription,
  workflow,
  workspaceId,
} from "./trigger-source-fixtures";

describe("GitHub Tracker Trigger source", () => {
  it.effect("lists the repository's labels without reading its issues", () => {
    const listLabels = vi.fn<GitHubClientService["listLabels"]>(() =>
      Effect.succeed(["needs-triage", "unused-yet"]),
    );

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      const source = githubTrackerInstance(client, Effect.succeed(registryState));
      const entry = source.entries.find(({ key }) => key === issueHasLabelKey);
      if (!entry) return assert.fail("missing issue-has-label entry");
      const options = yield* makeWorkflowOptions(source.options ?? []).list(entry, "label", [workspaceId]);

      assert.deepStrictEqual(options, [
        { value: "needs-triage", name: "needs-triage", listedIn: [workspaceId] },
        { value: "unused-yet", name: "unused-yet", listedIn: [workspaceId] },
      ]);
      assert.strictEqual(listLabels.mock.calls.length, 1);
    }).pipe(Effect.provide(Layer.mock(GitHubClient, { listLabels })));
  });

  it.effect("emits current labels and keeps person-comment revisions distinct by label", () =>
    Effect.gen(function* () {
      const client = yield* GitHubClient;
      const source = githubTrackerInstance(client, Effect.succeed(registryState));
      const events = yield* source
        .observe([
          subscription("github.issue-has-label", "label", [{ id: "label", value: "needs-triage" }]),
          subscription("github.new-comment-from-person", "comment", [
            { id: "label", value: "needs-triage" },
            { id: "catch-up-at-most", value: "7" },
          ]),
          subscription("github.new-comment-from-person", "ready-comment", [
            { id: "label", value: "ready-for-human" },
            { id: "catch-up-at-most", value: "7" },
          ]),
        ])
        .pipe(Stream.take(3), Stream.runCollect);

      assert.deepStrictEqual(
        [...events].map(({ entry, revision, cause }) => [entry, revision, cause._tag]),
        [
          [issueHasLabelKey, "label:needs-triage:1500", "Unknown"],
          [newIssueCommentKey, "comment:2:label:needs-triage", "Person"],
          [newIssueCommentKey, "comment:2:label:ready-for-human", "Person"],
        ],
      );
    }).pipe(
      Effect.provide(
        Layer.mock(GitHubClient, {
          ...issueReads,
          listIssues: () =>
            Effect.succeed([issue(2, true), { ...issue(1), labels: ["needs-triage", "ready-for-human"] }]),
          listIssueEvents: (_target, number) =>
            Effect.succeed([
              {
                id: number,
                event: "labeled",
                labelName: "needs-triage",
                createdAtMillis: number === 2 ? 1_200 : 1_500,
              },
            ]),
          listTriggerComments: (_target, number) =>
            Effect.succeed(
              number === 2
                ? []
                : [
                    {
                      id: 1,
                      authorLogin: "maintainer",
                      authorAssociation: "MEMBER",
                      body: "old",
                      createdAtMillis: 900,
                    },
                    {
                      id: 2,
                      authorLogin: "maintainer",
                      authorAssociation: "MEMBER",
                      body: "new",
                      createdAtMillis: 2_000,
                    },
                    {
                      id: 5,
                      authorLogin: "outside-user",
                      authorAssociation: "NONE",
                      body: "outside",
                      createdAtMillis: 1_600,
                    },
                    {
                      id: 3,
                      authorLogin: "maintainer",
                      authorAssociation: "MEMBER",
                      body: "written by Cogwork\n<!-- cogwork:agent-note -->",
                      createdAtMillis: 1_900,
                    },
                    {
                      id: 4,
                      authorLogin: "review-bot",
                      authorAssociation: "NONE",
                      authorType: "Bot",
                      body: "automated",
                      createdAtMillis: 1_800,
                    },
                  ],
            ),
        }),
      ),
    ),
  );

  it.effect("matches open issues only, and a not-blocked filter only unblocked issues", () =>
    Effect.gen(function* () {
      const client = yield* GitHubClient;
      const source = githubTrackerInstance(client, Effect.succeed(registryState));
      const label = [{ id: "label", value: "needs-triage" }];
      const labelled = { ...subscription("github.issue-has-label", "labelled", label), catchUp: null };
      const unblocked = { ...labelled, trigger: reviewTrigger, filters: [issueNotBlockedKey] };
      const events = yield* source.observe([labelled, unblocked]).pipe(Stream.take(2), Stream.runCollect);
      const admitted = (selected: TriggerSubscription) =>
        [...events].filter((event) => matchTriggerEvent([selected], event).length > 0).map(({ key }) => key);

      assert.deepStrictEqual(admitted(labelled), [
        { _tag: "Issue", workspace: workspaceId, id: firstIssueId },
        { _tag: "Issue", workspace: workspaceId, id: secondIssueId },
      ]);
      assert.deepStrictEqual(admitted(unblocked), [
        { _tag: "Issue", workspace: workspaceId, id: firstIssueId },
      ]);
    }).pipe(
      Effect.provide(
        Layer.mock(GitHubClient, {
          ...issueReads,
          listIssues: () =>
            Effect.succeed([
              { ...issue(3), state: "closed", createdAtMillis: 0 },
              issue(1),
              { ...issue(2), openBlockers: 1 },
            ]),
          listIssueEvents: () => Effect.succeed([]),
        }),
      ),
    ),
  );

  it.effect("reads every open issue with a filtered Trigger's label, so an unblocked issue is seen", () => {
    const listIssues = vi.fn<GitHubClientService["listIssues"]>((_target, query) =>
      Effect.succeed(query?.label === "needs-triage" ? [issue(1)] : []),
    );
    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      const source = githubTrackerInstance(client, Effect.succeed(registryState));
      const filtered = {
        ...subscription("github.issue-has-label", "unblocked", [{ id: "label", value: "needs-triage" }]),
        catchUp: null,
        filters: [issueNotBlockedKey],
      };
      const events = yield* source.observe([filtered]).pipe(Stream.take(1), Stream.runCollect);

      assert.deepStrictEqual(
        [...events].map(({ key }) => key),
        [{ _tag: "Issue", workspace: workspaceId, id: firstIssueId }],
      );
      assert.deepStrictEqual(listIssues.mock.calls.at(-1)?.[1], { state: "open", label: "needs-triage" });
    }).pipe(
      Effect.provide(
        Layer.mock(GitHubClient, { ...issueReads, listIssues, listIssueEvents: () => Effect.succeed([]) }),
      ),
    );
  });

  it.effect.each([
    { case: "still matches", read: issue(1), filtered: true, expected: Recheck.Matches() },
    {
      case: "is closed",
      read: { ...issue(1), state: "closed" as const },
      filtered: false,
      expected: Recheck.Ended({ reason: "#1 is closed" }),
    },
    {
      case: "lost its label",
      read: { ...issue(1), labels: [] },
      filtered: false,
      expected: Recheck.Ended({ reason: "#1 no longer has label needs-triage" }),
    },
    {
      case: "is blocked",
      read: { ...issue(1), openBlockers: 2 },
      filtered: true,
      expected: Recheck.Waiting({ reason: "#1 fails Issue is not blocked" }),
    },
    {
      case: "is blocked, unfiltered",
      read: { ...issue(1), openBlockers: 2 },
      filtered: false,
      expected: Recheck.Matches(),
    },
  ])("rechecks an issue that $case", ({ read, filtered, expected }) =>
    Effect.gen(function* () {
      const client = yield* GitHubClient;
      const source = githubTrackerInstance(client, Effect.succeed(registryState));
      const labelled = subscription("github.issue-has-label", "label", [
        { id: "label", value: "needs-triage" },
      ]);
      const selected = filtered ? { ...labelled, filters: [issueNotBlockedKey] } : labelled;
      const event = {
        key: { _tag: "Issue" as const, workspace: workspaceId, id: firstIssueId },
        revision: "label:needs-triage:1",
        cause: { _tag: "Unknown" as const },
        atMillis: 1,
        entry: issueHasLabelKey,
        workspace: workspaceId,
      };
      const result = yield* source.recheck?.(event, selected) ?? Effect.die("missing recheck");

      assert.deepStrictEqual(result, expected);
    }).pipe(Effect.provide(Layer.mock(GitHubClient, { readIssue: () => Effect.succeed(read) }))),
  );

  it.effect("carries the trimmed issue title and its link on a label event", () =>
    Effect.gen(function* () {
      const client = yield* GitHubClient;
      const source = githubTrackerInstance(client, Effect.succeed(registryState));
      const events = yield* source
        .observe([subscription("github.issue-has-label", "label", [{ id: "label", value: "needs-triage" }])])
        .pipe(Stream.take(1), Stream.runCollect);

      assert.deepStrictEqual(
        [...events].map(({ subject }) => subject),
        [{ title: "Fix login", url: "https://github.com/acme/example/issues/1" }],
      );
    }).pipe(
      Effect.provide(
        Layer.mock(GitHubClient, {
          ...issueReads,
          listIssues: () => Effect.succeed([{ ...issue(1), title: "  Fix login " }]),
          listIssueEvents: () => Effect.succeed([]),
        }),
      ),
    ),
  );

  it.effect("carries the creating Workflow lineage into issue label events", () =>
    Effect.gen(function* () {
      const inherited = { root: LineageId.make("issue:root"), parent: null, hop: 4 } as const;
      const origin = WorkflowActionOrigin.make({
        item: keyOf({ _tag: "Issue", workspace: workspaceId, id: firstIssueId }),
        workflow,
        attempt: RunId.make("creating-run"),
        writeKey: "create-issue",
        lineage: inherited,
      });
      const artifacts = {
        record: () => Effect.die("unused"),
        all: Effect.die("unused"),
        byLineage: () => Effect.die("unused"),
        origin: () => Effect.succeed(origin),
      } satisfies WorkflowArtifactStoreService;
      const client = yield* GitHubClient;
      const [event] = yield* githubTrackerInstance(client, Effect.succeed(registryState), artifacts)
        .observe([subscription("github.issue-has-label", "label", [{ id: "label", value: "needs-triage" }])])
        .pipe(Stream.take(1), Stream.runCollect);

      assert.deepStrictEqual(event?.cause, {
        _tag: "Cogwork",
        origin: origin.item,
        lineage: inherited,
      });
    }).pipe(
      Effect.provide(
        Layer.mock(GitHubClient, {
          ...issueReads,
          listIssues: () => Effect.succeed([issue(1)]),
          listIssueEvents: () =>
            Effect.succeed([{ id: 1, event: "labeled", labelName: "needs-triage", createdAtMillis: 1_500 }]),
          listTriggerComments: () => Effect.succeed([]),
        }),
      ),
    ),
  );

  it.effect("ranks issue events by the configured priority field", () =>
    Effect.gen(function* () {
      const client = yield* GitHubClient;
      const events = yield* githubTrackerInstance(
        client,
        Effect.succeed({ workspaces: [prioritizedWorkspace], failures: [] }),
      )
        .observe([subscription("github.issue-has-label", "label", [{ id: "label", value: "needs-triage" }])])
        .pipe(Stream.take(2), Stream.runCollect);

      assert.deepStrictEqual(
        Array.from(events, (event) => [event.key, event.priority]),
        [
          [{ _tag: "Issue", workspace: workspaceId, id: firstIssueId }, "urgent"],
          [{ _tag: "Issue", workspace: workspaceId, id: secondIssueId }, "medium"],
        ],
      );
    }).pipe(
      Effect.provide(
        Layer.mock(GitHubClient, {
          ...issueReads,
          listIssues: () => Effect.succeed([issue(1), issue(2)]),
          listIssueEvents: () => Effect.succeed([]),
          listTriggerComments: () => Effect.succeed([]),
          listPriorityFields: () => Effect.succeed([{ id: priorityFieldId, name: "Priority" }]),
          listIssueFieldValues: () => Effect.succeed(new Map([[1, new Map([[42, "Urgent"]])]])),
        }),
      ),
    ),
  );
});
