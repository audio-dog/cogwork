import {
  keyOf,
  LineageId,
  WorkflowActionArtifact,
  WorkflowActionOrigin,
  WorkflowActionPlanStep,
  WorkflowDocument,
} from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";

import { GitError } from "./git";
import { githubSourceControlActionEntries } from "./github/provider";
import { emptyRegistry } from "./projector";
import { readOnlyRegistry, WorkspaceRegistry } from "./registry-service";
import { RunLedger } from "./run-ledger";
import { emptyService as emptySourceControl, SourceControlProvider } from "./source-control";
import { temporaryControlStoreLayer } from "./testing/temporary-control-store";
import { buildWorkflowActionPlan, executeWorkflowActionPlan } from "./workflow-action-plan";
import {
  ActionPlanProbe,
  admission,
  decodeBranch,
  decodeEntry,
  decodeHarness,
  decodeItem,
  decodeRun,
  item,
  namedPullRequestStep,
  openPullRequestStep,
  operation,
  plan,
  pullRequest,
  pullRequestUpdate,
  pullRequestWrites,
  ref,
  requirements,
  sourceStep,
  sourceWorkspace,
  workflow,
} from "./workflow-action-plan-fixtures";
import { WorkflowActionPlanStore } from "./workflow-action-plan-store";
import {
  WorkflowArtifactStore,
  controlStoreLayer as workflowArtifactControlStoreLayer,
} from "./workflow-artifact-store";
import { PullRequestReadiness, WorktreeManager } from "./worktree";

describe("Workflow action plan", () => {
  it.effect("freezes the named pull request head and rejects review comments outside its diff", () =>
    Effect.gen(function* () {
      const reviewOperation = {
        id: operation,
        name: "Review",
        instructionPackage: null,
        instruction: "Review the named pull request.",
        permissionProfile: "read-only",
        requires: [],
        model: { harness: null, model: null, options: [] },
        forEach: null,
        questions: [],
        transitions: [
          {
            when: [],
            actions: [
              {
                entry: decodeEntry("github.post-review"),
                parameters: [{ id: "event", value: "comment" }],
              },
            ],
            handOff: null,
          },
        ],
        hints: [],
      } as const;
      const document = WorkflowDocument.make({
        name: "Review",
        workspaces: { _tag: "Every" },
        triggers: [],
        operations: [reviewOperation],
      });
      const sourceControl = {
        ...emptySourceControl,
        readPullRequest: () =>
          Effect.succeed({
            ...pullRequest,
            headSha: "abc123",
            title: "Review actions",
            description: "Adds review actions.",
            diff: "diff --git a/src/review.ts b/src/review.ts\n--- a/src/review.ts\n+++ b/src/review.ts\n@@ -10,2 +10,3 @@\n context\n-old\n+new\n tail",
            changedFiles: [
              {
                path: "src/review.ts",
                status: "modified",
                additions: 1,
                deletions: 1,
                changes: 2,
                patch: null,
              },
            ],
            comments: [],
          }),
      };
      const build = (line: number) =>
        buildWorkflowActionPlan({
          admission,
          document,
          operation: reviewOperation,
          catalog: { entries: [...githubSourceControlActionEntries], instructionPackages: [], harnesses: [] },
          workspaces: [sourceWorkspace],
          output: {
            summary: "Reviewed",
            answers: {},
            workspace: sourceWorkspace.config.id,
            inputs: {
              pull_request: "#826",
              review_body: "Review body",
              review_comments: [{ path: "src/review.ts", line, body: "Check this." }],
            },
          },
          attempt: decodeRun(`review-${line}`),
          createdAtMillis: 20,
          workflowRevision: 1,
          sourceControl,
        });

      const built = yield* Effect.result(build(12));
      const rejected = yield* Effect.result(build(99));

      assert.isTrue(Result.isSuccess(built));
      if (Result.isSuccess(built)) {
        assert.deepInclude(built.success.steps[0]?.target, {
          _tag: "NamedPullRequest",
          headSha: "abc123",
        });
      }
      assert.isTrue(Result.isFailure(rejected));
      if (Result.isFailure(rejected)) assert.include(rejected.failure.message, "src/review.ts:99");
    }),
  );

  it.effect("posts each review event once and creates one pending review", () => {
    const reviewedPullRequest = { number: 826, url: "https://github.com/owner/repo/pull/826" };
    const initial = plan([
      namedPullRequestStep(0, "github.post-review", [{ id: "event", value: "approve" }]),
      namedPullRequestStep(1, "github.post-review", [{ id: "event", value: "comment" }]),
      namedPullRequestStep(2, "github.post-review", [{ id: "event", value: "request-changes" }]),
      namedPullRequestStep(3, "github.draft-review"),
    ]);

    return Effect.gen(function* () {
      const probe = yield* ActionPlanProbe;
      yield* (yield* WorkflowActionPlanStore).create(initial);
      yield* executeWorkflowActionPlan(initial, admission);

      assert.deepStrictEqual(yield* Ref.get(probe.calls), [
        "review:approve:abc123",
        "review:comment:abc123",
        "review:request-changes:abc123",
        "draft:abc123",
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          requirements,
          Layer.effect(
            SourceControlProvider,
            Effect.map(ActionPlanProbe, (probe) => ({
              ...emptySourceControl,
              postReview: (_workspace, _pullRequest, event, input, origin) =>
                Ref.update(probe.calls, (calls) => [...calls, `review:${event}:${input.commitId}`]).pipe(
                  Effect.map(() => pullRequestUpdate(reviewedPullRequest, origin)),
                ),
              draftReview: (_workspace, _pullRequest, input, origin) =>
                Ref.update(probe.calls, (calls) => [...calls, `draft:${input.commitId}`]).pipe(
                  Effect.map(() => pullRequestUpdate(reviewedPullRequest, origin)),
                ),
            })),
          ).pipe(Layer.provideMerge(requirements)),
          Layer.succeed(
            WorkspaceRegistry,
            readOnlyRegistry({ ...emptyRegistry, workspaces: [sourceWorkspace] }),
          ),
        ),
      ),
      Effect.scoped,
    );
  });

  it.effect("completes a pull request push without a write when there are no new commits", () => {
    const initial = plan([sourceStep("github.push-to-this-pull-request")]);
    return Effect.gen(function* () {
      const probe = yield* ActionPlanProbe;
      yield* (yield* WorkflowActionPlanStore).create(initial);
      const result = yield* executeWorkflowActionPlan(initial, admission);

      assert.deepStrictEqual(result, { _tag: "Complete", handOff: null });
      assert.isEmpty(yield* Ref.get(probe.pushOrigins));
    }).pipe(Effect.provide(pullRequestWrites({ branchAhead: false })), Effect.scoped);
  });

  it.effect("records the Run origin when it pushes new pull request commits", () => {
    const initial = plan([sourceStep("github.push-to-this-pull-request")]);

    return Effect.gen(function* () {
      const probe = yield* ActionPlanProbe;
      yield* (yield* WorkflowActionPlanStore).create(initial);
      yield* executeWorkflowActionPlan(initial, admission);
      assert.deepInclude((yield* Ref.get(probe.pushOrigins))[0], {
        attempt: initial.attempt,
        writeKey: "write-0",
      });
    }).pipe(Effect.provide(pullRequestWrites()), Effect.scoped);
  });

  it.effect("completes a push and a comment on a pull request that an earlier lineage opened", () => {
    const earlierIssue = { ...ref, id: decodeItem("#803") };
    const earlierOpen = WorkflowActionArtifact.make({
      kind: "PullRequestOpened",
      workspace: sourceWorkspace.config.id,
      issue: decodeItem(`#${pullRequest.number}`),
      url: pullRequest.url,
      origin: WorkflowActionOrigin.make({
        item: keyOf(earlierIssue),
        workflow,
        attempt: decodeRun("implement-attempt"),
        writeKey: "implement-open",
        lineage: { root: LineageId.make(keyOf(earlierIssue)), parent: null, hop: 0 },
      }),
    });
    const commentStep = WorkflowActionPlanStep.make({
      ...sourceStep("github.comment-on-this-pull-request"),
      position: 1,
      inputs: { comment: "Pushed the review fixes." },
      writeKey: "write-1",
    });
    const initial = plan([sourceStep("github.push-to-this-pull-request"), commentStep]);
    const controlStoreArtifacts = workflowArtifactControlStoreLayer.pipe(
      Layer.provide(temporaryControlStoreLayer),
    );

    return Effect.gen(function* () {
      const artifacts = yield* WorkflowArtifactStore;
      yield* artifacts.record(earlierOpen);
      yield* (yield* WorkflowActionPlanStore).create(initial);

      const result = yield* executeWorkflowActionPlan(initial, admission);

      assert.deepStrictEqual(result, { _tag: "Complete", handOff: null });
      assert.deepStrictEqual(
        (yield* artifacts.byLineage(admission.lineage.root)).map(({ kind, origin }) => ({
          kind,
          writeKey: origin.writeKey,
        })),
        [
          { kind: "PullRequestUpdated", writeKey: "write-0" },
          { kind: "PullRequestUpdated", writeKey: "write-1" },
        ],
      );
    }).pipe(Effect.provide(pullRequestWrites({ artifacts: controlStoreArtifacts })), Effect.scoped);
  });

  it.effect("freezes a new pull request only when the Run branch is ahead", () => {
    const openOperation = {
      id: operation,
      name: "Implement",
      instructionPackage: null,
      instruction: "Implement the Issue.",
      permissionProfile: "full",
      requires: [],
      model: { harness: null, model: null, options: [] },
      forEach: null,
      questions: [],
      transitions: [
        {
          when: [],
          actions: [{ entry: decodeEntry("github.open-pull-request"), parameters: [] }],
          handOff: null,
        },
      ],
      hints: [],
    } as const;
    const document = WorkflowDocument.make({
      name: "Implement",
      workspaces: { _tag: "Every" },
      triggers: [],
      operations: [openOperation],
    });
    const reason = "head 811-behind is not ahead of origin/main";
    const offline = "could not fetch origin";
    const readiness: Record<string, Effect.Effect<PullRequestReadiness, GitError>> = {
      "811-ahead": Effect.succeed(
        PullRequestReadiness.Ready({ headBranch: "811-ahead", baseBranch: "main" }),
      ),
      "811-behind": Effect.succeed(PullRequestReadiness.Declined({ reason })),
      "811-offline": Effect.fail(
        new GitError({ command: "git fetch origin", message: offline, retryable: true }),
      ),
    };
    const worktreeLayer = Layer.mock(WorktreeManager, {
      pullRequestReadiness: (_workspace, _item, headBranch = "") =>
        readiness[headBranch] ?? Effect.die(`unexpected head ${headBranch}`),
    });
    return Effect.gen(function* () {
      const worktrees = yield* WorktreeManager;
      const build = (runBranch: string) =>
        buildWorkflowActionPlan({
          admission,
          document,
          operation: openOperation,
          catalog: { entries: [...githubSourceControlActionEntries], instructionPackages: [], harnesses: [] },
          workspaces: [sourceWorkspace],
          output: {
            summary: "Implemented",
            answers: {},
            workspace: sourceWorkspace.config.id,
            inputs: { pr_title: "Open the pull request", pr_body: "Closes #811" },
          },
          attempt: decodeRun(`open-${runBranch}`),
          createdAtMillis: 20,
          workflowRevision: 1,
          worktrees,
          runBranch,
        });

      const ready = yield* build("811-ahead");
      const declined = yield* Effect.flip(build("811-behind"));
      const unavailable = yield* Effect.flip(build("811-offline"));

      assert.deepStrictEqual(ready.steps[0]?.target, openPullRequestStep.target);
      assert.deepInclude(declined, { reason: "declined", message: reason });
      assert.deepInclude(unavailable, { reason: "unavailable", message: offline });
    }).pipe(Effect.provide(worktreeLayer));
  });

  it.effect("opens the pull request from the Run branch without a second readiness check", () => {
    const sourceControlLayer = Layer.effect(
      SourceControlProvider,
      Effect.map(ActionPlanProbe, (probe) => ({
        ...emptySourceControl,
        openWorkflowPullRequest: (_workspace, input) =>
          Ref.update(probe.calls, (calls) => [
            ...calls,
            `open:${input.headBranch}->${input.baseBranch}`,
          ]).pipe(
            Effect.map(() =>
              WorkflowActionArtifact.make({
                kind: "PullRequestOpened",
                workspace: sourceWorkspace.config.id,
                issue: decodeItem("#830"),
                url: "https://github.com/owner/repo/pull/830",
                origin: input.origin,
              }),
            ),
          ),
      })),
    );
    const worktreeLayer = Layer.unwrap(
      Effect.map(ActionPlanProbe, (probe) =>
        Layer.mock(WorktreeManager, {
          pullRequestReadiness: (_workspace, _item, headBranch = "") =>
            Ref.update(probe.calls, (calls) => [...calls, "readiness"]).pipe(
              Effect.map(() => PullRequestReadiness.Ready({ headBranch, baseBranch: "main" })),
            ),
          pushBranch: (_workspace, headBranch) =>
            Ref.update(probe.calls, (calls) => [...calls, `push:${headBranch}`]),
        }),
      ),
    );
    const registryLayer = Layer.succeed(
      WorkspaceRegistry,
      readOnlyRegistry({ ...emptyRegistry, workspaces: [sourceWorkspace] }),
    );
    const initial = plan([openPullRequestStep]);

    return Effect.gen(function* () {
      const ledger = yield* RunLedger;
      yield* ledger.insertRun({
        id: initial.attempt,
        workspace: sourceWorkspace.config.id,
        workItem: item,
        operation: "implement",
        harness: decodeHarness("scripted"),
        branch: decodeBranch("811-open-the-pull-request"),
        session: null,
        usage: null,
        status: "running",
        startedAtMillis: 1,
        endedAtMillis: null,
      });
      yield* (yield* WorkflowActionPlanStore).create(initial);
      const result = yield* executeWorkflowActionPlan(initial, admission);
      assert.deepStrictEqual(result, { _tag: "Complete", handOff: null });
      assert.deepStrictEqual(yield* Ref.get((yield* ActionPlanProbe).calls), [
        "push:811-open-the-pull-request",
        "open:811-open-the-pull-request->main",
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mergeAll(sourceControlLayer, worktreeLayer).pipe(Layer.provideMerge(requirements)),
          registryLayer,
        ),
      ),
      Effect.scoped,
    );
  });
});
