import { BranchName, WorkflowDocument } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { GitError } from "./git";
import { emptyRegistry } from "./projector";
import { RunLedger } from "./run-ledger";
import type { TriggerAdmission } from "./trigger-observation-admission";
import { admission } from "./workflow-run-admissions-fixtures";
import { document, reviewWorkspace, workflowServiceWith } from "./workflow-run-documents-fixtures";
import { requirements, testProgram } from "./workflow-run-fixtures";
import { WorktreeError, WorktreeManager } from "./worktree";

const checkoutAdmission: TriggerAdmission = {
  ...admission,
  event: { ...admission.event, workspace: reviewWorkspace.config.id },
};

const checkoutDocument = WorkflowDocument.make({
  ...document,
  operations: document.operations.map((candidate) => ({ ...candidate, permissionProfile: "full" })),
});

class MergeInProgress extends Context.Service<MergeInProgress, Ref.Ref<boolean>>()(
  "@cogwork/engine/workflow-run-checkout.test/MergeInProgress",
) {
  static readonly layer = Layer.effect(MergeInProgress, Ref.make(false));
}

const mergeWorktreeLayer = Layer.unwrap(
  Effect.map(MergeInProgress, (mergeInProgress) =>
    Layer.mock(WorktreeManager, {
      operationInProgress: () =>
        Effect.map(Ref.get(mergeInProgress), (merging) =>
          merging
            ? { operation: "merge" as const, unmergedPaths: ["packages/engine/src/workflow-run.ts"] }
            : null,
        ),
      ensure: (_workspace, _item, options) =>
        Effect.flatMap(Ref.get(mergeInProgress), (merging) =>
          merging && !options?.resume
            ? Effect.fail(
                new WorktreeError({
                  reason: "operation-in-progress",
                  branch: "workflow",
                  path: "/worktrees/workflow",
                  operation: "merge",
                  unmergedPaths: ["packages/engine/src/workflow-run.ts"],
                  message: "branch workflow has a merge in progress",
                  retryable: false,
                }),
              )
            : Effect.succeed({
                branch: BranchName.make("workflow"),
                path: "/worktrees/workflow",
                created: false,
              }),
        ),
    }),
  ),
);

const mergeTestLayer = Layer.mergeAll(requirements, mergeWorktreeLayer).pipe(
  Layer.provideMerge(MergeInProgress.layer),
);

const unreachableRemoteLayer = Layer.mergeAll(
  requirements,
  Layer.mock(WorktreeManager, {
    ensure: () =>
      Effect.fail(
        new GitError({
          command: "git fetch origin",
          message: "git fetch origin timed out",
          reason: "timeout",
          retryable: true,
        }),
      ),
  }),
);

const checkoutProgram = (objects: ReadonlyArray<unknown>) =>
  testProgram(
    objects,
    { registry: { ...emptyRegistry, workspaces: [reviewWorkspace] } },
    workflowServiceWith(checkoutDocument),
  );

describe("WorkflowRun", () => {
  it.effect("resumes a handed-back Run whose worktree has a merge in progress", () =>
    Effect.gen(function* () {
      const { runner, notifications } = yield* checkoutProgram([
        {
          summary: "Needs a decision",
          stuck: true,
          answers: { done: "yes" },
          inputs: { notification: "Wait" },
        },
        { summary: "Merged", stuck: false, answers: { done: "yes" }, inputs: { notification: "Merged" } },
      ]);
      yield* runner.execute(checkoutAdmission);
      yield* Ref.set(yield* MergeInProgress, true);

      yield* runner.handBack({ item: checkoutAdmission.event.key, note: "Use the human decision" });
      yield* runner.execute(checkoutAdmission);

      assert.deepStrictEqual(
        (yield* notifications.list).map(({ summary }) => summary),
        ["Merged"],
      );
    }).pipe(Effect.provide(mergeTestLayer), Effect.scoped),
  );

  it.effect(
    "parks a fresh-Session Run as WorktreeBlocked on its first attempt when a merge is in progress",
    () =>
      Effect.gen(function* () {
        const { runner, coordination } = yield* checkoutProgram([
          { summary: "Merged", stuck: false, answers: { done: "yes" }, inputs: { notification: "Merged" } },
        ]);
        yield* Ref.set(yield* MergeInProgress, true);

        const outcome = yield* runner.execute(checkoutAdmission);

        assert.deepStrictEqual(
          {
            outcome,
            runs: yield* (yield* RunLedger).listRuns(10),
            attempts: (yield* Ref.get(coordination.attempts)).map(({ outcome, reason }) => ({
              outcome,
              reason,
            })),
            parks: (yield* Ref.get(coordination.parks)).map(({ reason }) => reason),
          },
          {
            outcome: "completed",
            runs: [],
            attempts: [{ outcome: "failed", reason: "branch workflow has a merge in progress" }],
            parks: [
              {
                _tag: "WorktreeBlocked",
                reason: "operation-in-progress",
                branch: "workflow",
                path: "/worktrees/workflow",
                operation: "merge",
                unmergedPaths: ["packages/engine/src/workflow-run.ts"],
              },
            ],
          },
        );
      }).pipe(Effect.provide(mergeTestLayer), Effect.scoped),
  );

  it.effect("refuses Hand Back on a WorktreeBlocked park while the merge is still in progress", () =>
    Effect.gen(function* () {
      const { runner, coordination } = yield* checkoutProgram([]);
      yield* Ref.set(yield* MergeInProgress, true);
      yield* runner.execute(checkoutAdmission);

      const handBack = yield* runner
        .handBack({ item: checkoutAdmission.event.key })
        .pipe(
          Effect.match({ onFailure: ({ reason, message }) => ({ reason, message }), onSuccess: () => null }),
        );

      assert.deepStrictEqual(
        {
          failure: handBack,
          parks: (yield* Ref.get(coordination.parks)).map(({ reason }) => reason._tag),
          handbacks: yield* Ref.get(coordination.handbacks),
        },
        {
          failure: {
            reason: "worktree-blocked",
            message:
              "Hand Back needs the worktree at /worktrees/workflow: branch workflow has a merge in progress (unmerged paths: packages/engine/src/workflow-run.ts). Finish or abort it first.",
          },
          parks: ["WorktreeBlocked"],
          handbacks: [],
        },
      );
    }).pipe(Effect.provide(mergeTestLayer), Effect.scoped),
  );

  it.effect("hands back a WorktreeBlocked park after the merge is aborted and reaches the harness", () =>
    Effect.gen(function* () {
      const { runner, notifications } = yield* checkoutProgram([
        { summary: "Merged", stuck: false, answers: { done: "yes" }, inputs: { notification: "Merged" } },
      ]);
      yield* Ref.set(yield* MergeInProgress, true);
      yield* runner.execute(checkoutAdmission);
      yield* Ref.set(yield* MergeInProgress, false);

      const handBack = yield* runner
        .handBack({ item: checkoutAdmission.event.key })
        .pipe(Effect.match({ onFailure: ({ reason }) => reason, onSuccess: () => "handed back" }));
      yield* runner.execute(checkoutAdmission);

      assert.deepStrictEqual(
        { handBack, notifications: (yield* notifications.list).map(({ summary }) => summary) },
        { handBack: "handed back", notifications: ["Merged"] },
      );
    }).pipe(Effect.provide(mergeTestLayer), Effect.scoped),
  );

  it.effect("retries a retryable checkout failure and parks it as Exhausted at the attempt limit", () =>
    Effect.gen(function* () {
      const { runner, coordination } = yield* checkoutProgram([]);

      const outcomes = yield* Effect.forEach([1, 2, 3], () => runner.execute(checkoutAdmission));

      assert.deepStrictEqual(
        {
          outcomes,
          attempts: (yield* Ref.get(coordination.attempts)).map(({ outcome }) => outcome),
          parks: (yield* Ref.get(coordination.parks)).map(({ reason }) => reason),
        },
        {
          outcomes: ["retry", "retry", "completed"],
          attempts: ["failed", "failed", "failed"],
          parks: [{ _tag: "Exhausted", reason: "git fetch origin timed out" }],
        },
      );
    }).pipe(Effect.provide(unreachableRemoteLayer), Effect.scoped),
  );

  it.effect("parks on the first attempt and creates no Run when the worktree manager is not configured", () =>
    Effect.gen(function* () {
      const { runner, coordination } = yield* checkoutProgram([]);

      const outcome = yield* runner.execute(checkoutAdmission);

      assert.deepStrictEqual(
        {
          outcome,
          runs: yield* (yield* RunLedger).listRuns(10),
          attempts: (yield* Ref.get(coordination.attempts)).map(({ outcome }) => outcome),
          parks: (yield* Ref.get(coordination.parks)).map(({ reason }) => reason),
        },
        {
          outcome: "completed",
          runs: [],
          attempts: ["failed"],
          parks: [{ _tag: "Exhausted", reason: "Worktree manager is not configured" }],
        },
      );
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );
});
