import {
  keyOf,
  WorkflowActionArtifact,
  WorkflowActionPlan,
  WorkflowActionPlanStep,
  WorkItemId,
  WorkspaceConfig,
} from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { IssueTrackerError } from "./issue-tracker";
import type { RegisteredWorkspace } from "./projector";
import { emptyRegistry } from "./projector";
import { RunLedger } from "./run-ledger";
import { RunRecorder } from "./run-recorder";
import { emptyService as emptySourceControl, type SourceControlProviderService } from "./source-control";
import type { WorkflowsService } from "./workflow";
import { WorkflowActionPlanStore } from "./workflow-action-plan-store";
import { admission } from "./workflow-run-admissions-fixtures";
import {
  decodeDecisionValue,
  decodeEntry,
  decodeNode,
  decodeRun,
  decodeWorkItem,
  documentWithTransition,
  githubSourceControlType,
  harnessName,
  notifyEntry,
  operation,
  waitForApprovalCatalogEntry,
  waitForApprovalEntry,
  workflow,
  workflowRecord,
  workflowServiceFor,
} from "./workflow-run-documents-fixtures";
import { probedRequirements, refusedRunUpdates, requirements, testProgram } from "./workflow-run-fixtures";

describe("WorkflowRun", () => {
  it.effect("refuses approval when the displayed plan digest is stale", () =>
    Effect.gen(function* () {
      const waitingDocument = yield* documentWithTransition({
        when: [{ question: decodeNode("done"), choice: decodeNode("yes") }],
        actions: [
          { entry: waitForApprovalEntry, parameters: [] },
          { entry: notifyEntry, parameters: [] },
        ],
        handOff: null,
      });
      const { runner, notifications, observationStore } = yield* testProgram(
        [
          {
            summary: "Ready",
            stuck: false,
            answers: { done: "yes" },
            inputs: { approval_request: "Run this plan", notification: "Original" },
          },
        ],
        {},
        workflowServiceFor(waitingDocument, [waitForApprovalCatalogEntry]),
      );
      yield* observationStore.putAll([admission]);
      yield* runner.execute(admission);
      const plan = yield* (yield* WorkflowActionPlanStore).pending(keyOf(admission.event.key), workflow);
      assert.isNotNull(plan);
      if (plan === null) return;

      const failure = yield* Effect.flip(
        runner.approve({ item: admission.event.key, attempt: plan.attempt, digest: "stale-digest" }),
      );

      assert.strictEqual(failure.reason, "stale-digest");
      assert.isEmpty(yield* notifications.list);
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("refuses approval after the source revision advances", () =>
    Effect.gen(function* () {
      const waitingDocument = yield* documentWithTransition({
        when: [{ question: decodeNode("done"), choice: decodeNode("yes") }],
        actions: [{ entry: waitForApprovalEntry, parameters: [] }],
        handOff: null,
      });
      const { runner, coordination, observationStore } = yield* testProgram(
        [
          {
            summary: "Ready",
            stuck: false,
            answers: { done: "yes" },
            inputs: { approval_request: "Run this plan" },
          },
        ],
        {},
        workflowServiceFor(waitingDocument, [waitForApprovalCatalogEntry]),
      );
      yield* observationStore.putAll([admission]);
      yield* runner.execute(admission);
      const plan = yield* (yield* WorkflowActionPlanStore).pending(keyOf(admission.event.key), workflow);
      assert.isNotNull(plan);
      if (plan === null) return;
      yield* Ref.set(coordination.observed, "1001");

      const failure = yield* Effect.flip(
        runner.approve({ item: admission.event.key, attempt: plan.attempt, digest: plan.digest }),
      );

      assert.strictEqual(failure.reason, "stale-attempt");
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("refuses edited approval after the published Workflow changes", () =>
    Effect.gen(function* () {
      const waitingDocument = yield* documentWithTransition({
        when: [{ question: decodeNode("done"), choice: decodeNode("yes") }],
        actions: [
          { entry: waitForApprovalEntry, parameters: [] },
          { entry: notifyEntry, parameters: [] },
        ],
        handOff: null,
      });
      const publishedRevision = yield* Ref.make(1);
      const baseService = workflowServiceFor(waitingDocument, [waitForApprovalCatalogEntry]);
      const service: WorkflowsService = {
        ...baseService,
        get: () =>
          Ref.get(publishedRevision).pipe(
            Effect.map((revision) => ({
              ...workflowRecord,
              workingCopy: waitingDocument,
              workingRevision: revision,
              publishedCopy: waitingDocument,
              publishedRevision: revision,
            })),
          ),
      };
      const { runner, observationStore } = yield* testProgram(
        [
          {
            summary: "Ready",
            stuck: false,
            answers: { done: "yes" },
            inputs: { approval_request: "Run this plan", notification: "Original" },
          },
        ],
        {},
        service,
      );
      yield* observationStore.putAll([admission]);
      yield* runner.execute(admission);
      const plan = yield* (yield* WorkflowActionPlanStore).pending(keyOf(admission.event.key), workflow);
      assert.isNotNull(plan);
      if (plan === null) return;
      yield* Ref.set(publishedRevision, 2);

      const failure = yield* Effect.flip(
        runner.approve({
          item: admission.event.key,
          attempt: plan.attempt,
          digest: plan.digest,
          edits: { notification: "Edited" },
        }),
      );

      assert.strictEqual(failure.reason, "stale-digest");
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("returns the rebuilt approval digest and dismisses its notification", () =>
    Effect.gen(function* () {
      const waitingDocument = yield* documentWithTransition({
        when: [{ question: decodeNode("done"), choice: decodeNode("yes") }],
        actions: [
          { entry: waitForApprovalEntry, parameters: [] },
          { entry: notifyEntry, parameters: [] },
        ],
        handOff: null,
      });
      const { runner, notifications, observationStore } = yield* testProgram(
        [
          {
            summary: "Ready",
            stuck: false,
            answers: { done: "yes" },
            inputs: { approval_request: "Run this plan", notification: "Original" },
          },
        ],
        {},
        workflowServiceFor(waitingDocument, [waitForApprovalCatalogEntry]),
      );
      yield* observationStore.putAll([admission]);
      yield* runner.execute(admission);
      const plan = yield* (yield* WorkflowActionPlanStore).pending(keyOf(admission.event.key), workflow);
      assert.isNotNull(plan);
      if (plan === null) return;

      const approvedDigest = yield* runner.approve({
        item: admission.event.key,
        attempt: plan.attempt,
        digest: plan.digest,
        edits: { notification: "Edited" },
      });

      const [notification] = yield* notifications.list;
      assert.deepInclude(notification, { summary: "Edited", item: admission.event.key });
      assert.include(notification?.id, keyOf(admission.event.key));
      assert.include(notification?.id, plan.attempt);
      assert.notStrictEqual(approvedDigest, plan.digest);
      assert.isNull(yield* (yield* WorkflowActionPlanStore).pending(keyOf(admission.event.key), workflow));
      const run = yield* (yield* RunLedger).getRun(plan.attempt);
      assert.isNotNull(run);
      if (run === null) return;
      const approval = (yield* (yield* RunRecorder).replay(run).pipe(Stream.runCollect)).find(
        ({ event }) => event.type === "CUSTOM" && event.name === "workflow.plan-approved",
      );
      const approvalValue = approval?.event.type === "CUSTOM" ? approval.event.value : undefined;
      assert.strictEqual(decodeDecisionValue(approvalValue).object.digest, approvedDigest);
      assert.isDefined(notification);
      if (!notification) return;
      yield* notifications.dismiss(notification.id);
      assert.isEmpty(yield* notifications.list);
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("keeps approval waiting on refresh failure and withdraws it for a new head", () =>
    Effect.gen(function* () {
      const reviewWorkspace: RegisteredWorkspace = {
        source: "test",
        repository: "owner/repo",
        contributions: [],
        config: yield* Schema.decodeEffect(WorkspaceConfig)({
          id: "repo",
          displayName: "repo",
          checkoutPath: "/repo",
          issueTracker: { type: "github" },
        }),
      };
      const attempt = decodeRun("waiting-review");
      const reviewPlan = WorkflowActionPlan.make({
        item: keyOf(admission.event.key),
        workflow,
        attempt,
        operation,
        revision: admission.event.revision,
        createdAtMillis: 1_000,
        consumedHandbackAtMillis: 0,
        digest: "waiting-review-digest",
        workflowRevision: 1,
        summary: "Review is ready",
        answers: { done: decodeNode("yes") },
        inputs: {
          pull_request: "#826",
          review_body: "Looks good.",
          review_comments: [],
          approval_request: "Post this review?",
        },
        workspace: reviewWorkspace.config.id,
        lineage: admission.lineage,
        handOff: null,
        steps: [
          WorkflowActionPlanStep.make({
            position: 0,
            entry: waitForApprovalEntry,
            parameters: [],
            inputs: { approval_request: "Post this review?" },
            target: { _tag: "Cogwork" },
            writeKey: "wait-review",
            status: "pending",
            failures: 0,
            artifact: null,
          }),
          WorkflowActionPlanStep.make({
            position: 1,
            entry: decodeEntry("github.post-review"),
            parameters: [{ id: "event", value: "approve" }],
            inputs: {
              pull_request: "#826",
              review_body: "Looks good.",
              review_comments: [],
            },
            target: {
              _tag: "NamedPullRequest",
              workspace: reviewWorkspace.config.id,
              app: githubSourceControlType,
              issueTracker: reviewWorkspace.config.issueTracker,
              repository: reviewWorkspace.repository ?? null,
              number: 826,
              url: "https://github.com/owner/repo/pull/826",
              headBranch: "826-review-actions",
              baseBranch: "main",
              headSha: "old-head",
            },
            writeKey: "post-review",
            status: "pending",
            failures: 0,
            artifact: null,
          }),
        ],
      });
      const refreshAvailable = yield* Ref.make(false);
      const reviewWrites = yield* Ref.make(0);
      const sourceControl = {
        ...emptySourceControl,
        readPullRequest: () =>
          Ref.get(refreshAvailable).pipe(
            Effect.flatMap((available) =>
              available
                ? Effect.succeed({
                    number: 826,
                    url: "https://github.com/owner/repo/pull/826",
                    headBranch: "826-review-actions",
                    baseBranch: "main",
                    headSha: "new-head",
                    title: "Review actions",
                    description: "Adds review actions.",
                    diff: "",
                    changedFiles: [],
                    comments: [],
                  })
                : Effect.fail(
                    new IssueTrackerError({
                      reason: "unavailable",
                      retryable: true,
                      message: "GitHub unavailable",
                    }),
                  ),
            ),
          ),
        postReview: (selected, pullRequest, _event, _input, origin) =>
          Ref.update(reviewWrites, (count) => count + 1).pipe(
            Effect.map(() =>
              WorkflowActionArtifact.make({
                kind: "PullRequestUpdated",
                workspace: selected.config.id,
                issue: WorkItemId.make(`#${pullRequest.number}`),
                url: pullRequest.url,
                origin,
              }),
            ),
          ),
      } satisfies SourceControlProviderService;
      const { runner, coordination, observationStore } = yield* testProgram([], {
        registry: { ...emptyRegistry, workspaces: [reviewWorkspace] },
        sourceControl,
      });
      yield* observationStore.putAll([admission]);
      yield* (yield* WorkflowActionPlanStore).create(reviewPlan);
      yield* (yield* RunLedger).insertRun({
        id: attempt,
        workspace: reviewWorkspace.config.id,
        workItem: decodeWorkItem("#826"),
        operation: "implement",
        harness: harnessName,
        branch: null,
        session: null,
        usage: null,
        status: "succeeded",
        startedAtMillis: 1,
        endedAtMillis: 2,
      });

      const unavailableApproval = yield* Effect.result(
        runner.approve({
          item: admission.event.key,
          attempt,
          digest: reviewPlan.digest,
        }),
      );
      assert.isTrue(Result.isFailure(unavailableApproval));
      if (Result.isFailure(unavailableApproval)) {
        assert.strictEqual(unavailableApproval.failure.reason, "unavailable");
      }
      assert.strictEqual(yield* Ref.get(reviewWrites), 0);
      assert.isNotNull(yield* (yield* WorkflowActionPlanStore).pending(reviewPlan.item, workflow));

      yield* Ref.set(refreshAvailable, true);
      yield* runner.refreshReviewPlans();

      assert.isNull(yield* (yield* WorkflowActionPlanStore).pending(reviewPlan.item, workflow));
      assert.strictEqual(
        (yield* Ref.get(coordination.handbacks))[0]?.note,
        "The pull request received a new commit. Review the new head.",
      );
      assert.deepInclude(yield* (yield* RunLedger).getRun(attempt), {
        status: "succeeded",
        endedAtMillis: 2,
      });
      assert.isEmpty(yield* refusedRunUpdates());
    }).pipe(Effect.provide(probedRequirements), Effect.scoped),
  );

  it.effect("rejects an approval plan as Stop and records the person's note", () =>
    Effect.gen(function* () {
      const waitingDocument = yield* documentWithTransition({
        when: [{ question: decodeNode("done"), choice: decodeNode("yes") }],
        actions: [{ entry: waitForApprovalEntry, parameters: [] }],
        handOff: null,
      });
      const { runner, observationStore } = yield* testProgram(
        [
          {
            summary: "Ready",
            stuck: false,
            answers: { done: "yes" },
            inputs: { approval_request: "Run this plan" },
          },
        ],
        {},
        workflowServiceFor(waitingDocument, [waitForApprovalCatalogEntry]),
      );
      yield* observationStore.putAll([admission]);
      yield* runner.execute(admission);
      const plan = yield* (yield* WorkflowActionPlanStore).pending(keyOf(admission.event.key), workflow);
      assert.isNotNull(plan);
      if (plan === null) return;

      yield* runner.reject({
        item: admission.event.key,
        attempt: plan.attempt,
        note: "The source is no longer relevant",
      });

      assert.isNull(yield* (yield* WorkflowActionPlanStore).pending(keyOf(admission.event.key), workflow));
      assert.isEmpty(yield* observationStore.admissions);
      const run = yield* (yield* RunLedger).getRun(plan.attempt);
      assert.isNotNull(run);
      if (run === null) return;
      const rejection = (yield* (yield* RunRecorder).replay(run).pipe(Stream.runCollect)).find(
        ({ event }) => event.type === "CUSTOM" && event.name === "workflow.plan-rejected",
      );
      const rejectionValue = rejection?.event.type === "CUSTOM" ? rejection.event.value : undefined;
      assert.deepInclude(decodeDecisionValue(rejectionValue).object, {
        note: "The source is no longer relevant",
      });
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );
});
