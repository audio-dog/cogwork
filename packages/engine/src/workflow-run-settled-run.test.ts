import {
  IssueTrackerType,
  keyOf,
  WorkflowActionPlan,
  WorkflowActionPlanStep,
  type WorkflowCatalogEntry,
  WorkflowDocument,
} from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import {
  IssueTrackerError,
  type IssueTrackerService,
  makeEmpty as makeEmptyIssueTracker,
} from "./issue-tracker";
import { emptyRegistry } from "./registry";
import { RunLedger, type RunLedgerService } from "./run-ledger";
import { WorkflowActionPlanStore } from "./workflow-action-plan-store";
import { admission } from "./workflow-run-admissions-fixtures";
import {
  decodeEntry,
  decodeNode,
  decodeRun,
  decodeWorkItem,
  decodeWorkspace,
  document,
  documentWithTransition,
  harnessName,
  operation,
  reviewWorkspace,
  waitForApprovalCatalogEntry,
  waitForApprovalEntry,
  workflow,
  workflowServiceFor,
} from "./workflow-run-documents-fixtures";
import { probedRequirements, refusedRunUpdates, testProgram } from "./workflow-run-fixtures";

describe("WorkflowRun", () => {
  it.effect("keeps the Run's status when a new source revision withdraws its plan", () =>
    Effect.gen(function* () {
      const staleAttempt = decodeRun("stale-plan");
      const stalePlan = WorkflowActionPlan.make({
        item: keyOf(admission.event.key),
        workflow,
        attempt: staleAttempt,
        operation,
        revision: "999",
        createdAtMillis: 1,
        consumedHandbackAtMillis: 0,
        digest: "stale-plan",
        summary: "Stale plan",
        answers: {},
        lineage: admission.lineage,
        handOff: null,
        steps: [],
      });
      const ledger = yield* RunLedger;
      yield* ledger.insertRun({
        id: staleAttempt,
        workspace: decodeWorkspace(workflow),
        workItem: decodeWorkItem(keyOf(admission.event.key)),
        operation: "implement",
        harness: harnessName,
        branch: null,
        session: null,
        usage: null,
        status: "succeeded",
        startedAtMillis: 1,
        endedAtMillis: 2,
      });
      yield* (yield* WorkflowActionPlanStore).create(stalePlan);
      const { runner } = yield* testProgram([
        {
          summary: "Current plan",
          stuck: false,
          answers: { done: "yes" },
          inputs: { notification: "Current plan" },
        },
      ]);

      yield* runner.execute(admission);

      assert.deepInclude(yield* ledger.getRun(staleAttempt), {
        status: "succeeded",
        endedAtMillis: 2,
      });
      assert.isEmpty(yield* refusedRunUpdates());
    }).pipe(Effect.provide(probedRequirements), Effect.scoped),
  );

  const commentIssueEntry = decodeEntry("github.comment-issue");

  const commentIssueCatalogEntry = {
    key: commentIssueEntry,
    name: "Comment on an issue",
    kind: "action" as const,
    system: "github",
    connection: "github",
    requires: [],
    parameters: [],
    itemKind: null,
    actsOn: ["*"],
    requiresWorkspace: true,
    workspaceSource: "agent",
    permissionProfile: "read-only" as const,
    agentInputs: ["issue", "comment"],
    emits: [],
  } satisfies WorkflowCatalogEntry;

  const commentStep = (position: number, status: "pending" | "completed") =>
    WorkflowActionPlanStep.make({
      position,
      entry: commentIssueEntry,
      parameters: [],
      inputs: { issue: "#12", comment: `Step ${position}` },
      target: {
        _tag: "ExistingIssue",
        workspace: reviewWorkspace.config.name,
        app: IssueTrackerType.make("github"),
        issueTracker: reviewWorkspace.config.issueTracker,
        repository: null,
        issue: decodeWorkItem("#12"),
      },
      writeKey: `settled-run:${position}`,
      status,
      failures: 0,
      artifact: null,
    });

  const commentProbe = Effect.fn("WorkflowRunTest.commentProbe")(function* (failuresBeforeSuccess: number) {
    const comments = yield* Ref.make<ReadonlyArray<string>>([]);
    const failuresLeft = yield* Ref.make(failuresBeforeSuccess);
    const tracker = {
      ...(yield* makeEmptyIssueTracker),
      commentIssue: (_workspace, issue, body) =>
        Ref.getAndUpdate(failuresLeft, (left) => Math.max(0, left - 1)).pipe(
          Effect.flatMap((left) =>
            left > 0
              ? Effect.fail(
                  new IssueTrackerError({
                    reason: "unavailable",
                    retryable: true,
                    message: "GitHub unavailable",
                  }),
                )
              : Ref.update(comments, (current) => [...current, `${issue}:${body}`]),
          ),
        ),
    } satisfies IssueTrackerService;
    return { comments, tracker };
  });

  const settledRunMechanisms = [
    {
      name: "crash recovery at boot",
      status: "crashed",
      settle: (ledger: RunLedgerService) =>
        ledger.crashRunning(decodeWorkspace(workflow), decodeWorkItem(keyOf(admission.event.key)), 5),
    },
    {
      name: "a drain",
      status: "interrupted",
      settle: (ledger: RunLedgerService) => ledger.interruptRunning(0, 5),
    },
  ] as const;

  it.effect.each(settledRunMechanisms)(
    "keeps a Run settled by $name when its pending Action plan resumes and completes",
    ({ status, settle }) =>
      Effect.gen(function* () {
        const { comments, tracker } = yield* commentProbe(0);
        const { runner } = yield* testProgram([], { issueTracker: tracker });
        const ledger = yield* RunLedger;
        const attempt = decodeRun("settled-run");
        yield* ledger.insertRun({
          id: attempt,
          workspace: decodeWorkspace(workflow),
          workItem: decodeWorkItem(keyOf(admission.event.key)),
          operation: "implement",
          harness: harnessName,
          branch: null,
          session: null,
          usage: null,
          status: "running",
          startedAtMillis: 1,
          endedAtMillis: null,
        });
        yield* (yield* WorkflowActionPlanStore).create(
          WorkflowActionPlan.make({
            item: keyOf(admission.event.key),
            workflow,
            attempt,
            operation,
            revision: admission.event.revision,
            createdAtMillis: 1,
            consumedHandbackAtMillis: 0,
            digest: "settled-run",
            summary: "Two comments",
            answers: {},
            lineage: admission.lineage,
            handOff: null,
            steps: [commentStep(0, "completed"), commentStep(1, "pending")],
          }),
        );
        yield* settle(ledger);
        yield* TestClock.adjust("1 minute");

        assert.strictEqual(yield* runner.execute(admission), "completed");

        assert.deepStrictEqual(yield* Ref.get(comments), ["#12:Step 1"]);
        assert.deepInclude(yield* ledger.getRun(attempt), { status, endedAtMillis: 5 });
        assert.lengthOf(yield* ledger.listRuns(10), 1);
        assert.isNull(yield* ledger.latestSeq(attempt));
        assert.isEmpty(yield* refusedRunUpdates());
      }).pipe(Effect.provide(probedRequirements), Effect.scoped),
  );

  it.effect("keeps a Run settled failed by a retryable write failure when a later resume completes", () =>
    Effect.gen(function* () {
      const commentDocument = WorkflowDocument.make({
        ...document,
        workspaces: { _tag: "Every" },
        operations: document.operations.map((candidate) => ({
          ...candidate,
          transitions: candidate.transitions.map((transition) => ({
            ...transition,
            actions: [{ entry: commentIssueEntry, parameters: [] }],
          })),
        })),
      });
      const { comments, tracker } = yield* commentProbe(1);
      const { runner } = yield* testProgram(
        [
          {
            summary: "Comment ready",
            stuck: false,
            answers: { done: "yes" },
            workspace: reviewWorkspace.config.name,
            inputs: { issue: "#12", comment: "Captured" },
          },
        ],
        { issueTracker: tracker, registry: { ...emptyRegistry, workspaces: [reviewWorkspace] } },
        workflowServiceFor(commentDocument, [commentIssueCatalogEntry]),
      );
      const ledger = yield* RunLedger;

      assert.strictEqual(yield* runner.execute(admission), "retry");
      const [settled] = yield* ledger.listRuns(10);
      assert.isDefined(settled);
      if (!settled) return;
      assert.strictEqual(settled.status, "failed");
      const seqBeforeResume = yield* ledger.latestSeq(settled.id);
      yield* TestClock.adjust("1 minute");

      assert.strictEqual(yield* runner.execute(admission), "completed");

      assert.deepStrictEqual(yield* Ref.get(comments), ["#12:Captured"]);
      const runs = yield* ledger.listRuns(10);
      assert.deepStrictEqual(
        runs.map(({ id, status, endedAtMillis }) => ({ id, status, endedAtMillis })),
        [{ id: settled.id, status: "failed", endedAtMillis: settled.endedAtMillis }],
      );
      assert.strictEqual(yield* ledger.latestSeq(settled.id), seqBeforeResume);
      assert.isEmpty(yield* refusedRunUpdates());
    }).pipe(Effect.provide(probedRequirements), Effect.scoped),
  );

  it.effect("keeps a Run settled at approval when the approved plan resumes", () =>
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
      const ledger = yield* RunLedger;
      const settled = yield* ledger.getRun(plan.attempt);
      assert.deepInclude(settled, { status: "succeeded" });
      yield* TestClock.adjust("1 minute");

      yield* runner.approve({ item: admission.event.key, attempt: plan.attempt, digest: plan.digest });

      assert.isNull(yield* (yield* WorkflowActionPlanStore).pending(keyOf(admission.event.key), workflow));
      assert.deepStrictEqual(yield* ledger.getRun(plan.attempt), settled);
      assert.isEmpty(yield* refusedRunUpdates());
    }).pipe(Effect.provide(probedRequirements), Effect.scoped),
  );
});
