import { BranchName, type RunPlanGitOperationInProgress, WorkflowDocument } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { Git, GitError, type GitOperationInProgress, type GitOperationRecord, type GitService } from "./git";
import { HarnessError } from "./harness";
import { emptyRegistry } from "./projector";
import { RunLedger } from "./run-ledger";
import type { TriggerAdmission } from "./trigger-observation-admission";
import { admission } from "./workflow-run-admissions-fixtures";
import { document, reviewWorkspace, workflowServiceWith } from "./workflow-run-documents-fixtures";
import { type HarnessBehavior, requirements, resultEvent, testProgram } from "./workflow-run-fixtures";
import { managerLayer, WorktreeError, WorktreeManager } from "./worktree";
import { WorktreeFs, type WorktreeFsService } from "./worktree-fs";

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
            ? {
                operation: "merge" as const,
                identity: "merge-head",
                head: "head",
                unmergedPaths: ["packages/engine/src/workflow-run.ts"],
              }
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
                operationInProgress: null,
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

interface WorktreeGitState {
  readonly registered: ReadonlyArray<string>;
  readonly operation: GitOperationInProgress | null;
  readonly record: GitOperationRecord | null;
}

class WorktreeGit extends Context.Service<WorktreeGit, Ref.Ref<WorktreeGitState>>()(
  "@cogwork/engine/workflow-run-checkout.test/WorktreeGit",
) {
  static readonly layer = Layer.effect(
    WorktreeGit,
    Ref.make<WorktreeGitState>({ registered: [], operation: null, record: null }),
  );
}

const statefulGit = (state: Ref.Ref<WorktreeGitState>) =>
  ({
    fetch: () => Effect.void,
    remoteBranchExists: () => Effect.succeed(false),
    addWorktree: ({ worktreePath }) =>
      Ref.update(state, (current) => ({ ...current, registered: [...current.registered, worktreePath] })),
    removeWorktree: () => Effect.die("unused"),
    listWorktrees: () =>
      Ref.get(state).pipe(Effect.map(({ registered }) => registered.map((path) => ({ path, branch: null })))),
    fastForward: () => Effect.void,
    divergence: () => Effect.succeed({ ahead: 0, behind: 0 }),
    operationInProgress: () => Ref.get(state).pipe(Effect.map(({ operation }) => operation)),
    recordedOperation: () => Ref.get(state).pipe(Effect.map(({ record }) => record)),
    recordOperation: (_worktreePath, record) => Ref.update(state, (current) => ({ ...current, record })),
    rebase: () => Effect.die("unused"),
    remoteUrl: () => Effect.die("unused"),
    blockPush: () => Effect.void,
    allowPush: () => Effect.void,
    pushBranch: () => Effect.die("unused"),
  }) satisfies GitService;

const emptyWorktreeFs = {
  linkFile: () => Effect.void,
  removeDebris: () => Effect.succeed(true),
  runCommand: () => Effect.void,
  stat: () => Effect.succeed(null),
} satisfies WorktreeFsService;

const statefulGitLayer = Layer.effect(Git, Effect.map(WorktreeGit, statefulGit));

const worktreeTestLayer = Layer.mergeAll(
  requirements,
  managerLayer.pipe(Layer.provide(Layer.merge(statefulGitLayer, Layer.succeed(WorktreeFs, emptyWorktreeFs)))),
).pipe(Layer.provideMerge(WorktreeGit.layer));

const leftMerge: GitOperationInProgress = {
  operation: "merge",
  identity: "5eed0001",
  head: "4ead0001",
  unmergedPaths: ["packages/engine/src/workflow-run.ts"],
};

const otherMerge: GitOperationInProgress = { ...leftMerge, identity: "5eed0002" };

const setOperation = (state: Ref.Ref<WorktreeGitState>, operation: GitOperationInProgress | null) =>
  Ref.update(state, (current) => ({ ...current, operation }));

type HarnessRun = NonNullable<HarnessBehavior["run"]>;
type HarnessTurn = ReturnType<HarnessRun>;

interface HarnessVisit {
  readonly session: Parameters<HarnessRun>[0]["session"];
  readonly gitOperationInProgress: RunPlanGitOperationInProgress | null;
}

const scriptedHarness = Effect.fn("WorkflowRunTest.scriptedHarness")(function* (
  turns: ReadonlyArray<HarnessTurn>,
) {
  const remaining = yield* Ref.make(turns);
  const visits = yield* Ref.make<ReadonlyArray<HarnessVisit>>([]);
  const run: HarnessRun = ({ plan, session }) =>
    Stream.unwrap(
      Ref.update(visits, (current) => [
        ...current,
        { session, gitOperationInProgress: plan.workContext.facts.gitOperationInProgress ?? null },
      ]).pipe(
        Effect.andThen(
          Ref.modify(remaining, ([next, ...rest]) => [next ?? Stream.die("no scripted Harness turn"), rest]),
        ),
      ),
    );
  return { run, visits };
});

const resultTurn = (object: unknown): HarnessTurn => Stream.make(resultEvent(object));

const failedTurn: HarnessTurn = Stream.fail(
  new HarnessError({ reason: "turn", retryable: true, message: "The model connection closed" }),
);

const afterMerge = (state: Ref.Ref<WorktreeGitState>, turn: HarnessTurn) =>
  Stream.unwrap(setOperation(state, leftMerge).pipe(Effect.map(() => turn)));

const stuckResult = {
  summary: "Needs a decision",
  stuck: true,
  answers: { done: "yes" },
  inputs: { notification: "Wait" },
};
const mergedResult = {
  summary: "Merged",
  stuck: false,
  answers: { done: "yes" },
  inputs: { notification: "Merged" },
};

type WorkflowRunner = Effect.Success<ReturnType<typeof testProgram>>["runner"];

const nextRevision = (current: TriggerAdmission): TriggerAdmission => ({
  ...current,
  event: {
    ...current.event,
    revision: `${current.event.revision}-next`,
    atMillis: current.event.atMillis + 1,
  },
});

const checkoutProgram = (objects: ReadonlyArray<unknown>, behavior: HarnessBehavior = {}) =>
  testProgram(
    objects,
    { ...behavior, registry: { ...emptyRegistry, workspaces: [reviewWorkspace] } },
    workflowServiceWith(checkoutDocument),
  );

describe("WorkflowRun", () => {
  const leftMergeFact = {
    operation: "merge",
    unmergedPaths: ["packages/engine/src/workflow-run.ts"],
    instruction:
      "This merge was in progress in the worktree when the last Run of this work item ended. Finish or abort it before any other work.",
  } satisfies RunPlanGitOperationInProgress;

  const continuations = [
    {
      name: "a retry after a Harness that fails once it starts a merge",
      firstTurn: failedTurn,
      next: (runner: WorkflowRunner) => runner.execute(checkoutAdmission),
      session: "fresh",
    },
    {
      name: "the next revision after a valid result while a merge is in progress",
      firstTurn: resultTurn(mergedResult),
      next: (runner: WorkflowRunner) => runner.execute(nextRevision(checkoutAdmission)),
      session: "fresh",
    },
    {
      name: "a handback after a valid result while a merge is in progress",
      firstTurn: resultTurn(stuckResult),
      next: (runner: WorkflowRunner) =>
        runner
          .handBack({ item: checkoutAdmission.event.key, note: "Finish the merge" })
          .pipe(Effect.andThen(runner.execute(checkoutAdmission))),
      session: "resumed",
    },
  ] as const;

  continuations.map(({ name, firstTurn, next, session }) =>
    it.effect(`gives the merge a Run left to ${name}`, () =>
      Effect.gen(function* () {
        const git = yield* WorktreeGit;
        const harness = yield* scriptedHarness([afterMerge(git, firstTurn), resultTurn(mergedResult)]);
        const { runner } = yield* checkoutProgram([], { run: harness.run });

        yield* runner.execute(checkoutAdmission);
        yield* next(runner);

        const [first, second] = yield* Ref.get(harness.visits);
        assert.deepStrictEqual(
          {
            facts: [first?.gitOperationInProgress, second?.gitOperationInProgress],
            session: first?.session === second?.session ? "resumed" : "fresh",
          },
          { facts: [null, leftMergeFact], session },
        );
      }).pipe(Effect.provide(worktreeTestLayer), Effect.scoped),
    ),
  );

  const handBackAndContinue = (runner: WorkflowRunner) =>
    runner
      .handBack({ item: checkoutAdmission.event.key, note: "Continue" })
      .pipe(Effect.andThen(runner.execute(checkoutAdmission)));

  const unrecordedMerges = [
    {
      name: "a merge a person starts before the next fresh-Session Run",
      firstTurn: () => resultTurn(mergedResult),
      personMerge: leftMerge,
      next: (runner: WorkflowRunner) => runner.execute(nextRevision(checkoutAdmission)),
    },
    {
      name: "a merge a person starts before a handback resumes the Session",
      firstTurn: () => resultTurn(stuckResult),
      personMerge: leftMerge,
      next: handBackAndContinue,
    },
    {
      name: "a different merge a person starts after aborting the recorded one",
      firstTurn: (git: Ref.Ref<WorktreeGitState>) => afterMerge(git, resultTurn(stuckResult)),
      personMerge: otherMerge,
      next: handBackAndContinue,
    },
  ] as const;

  unrecordedMerges.map(({ name, firstTurn, personMerge, next }) =>
    it.effect(`refuses ${name}`, () =>
      Effect.gen(function* () {
        const git = yield* WorktreeGit;
        const harness = yield* scriptedHarness([firstTurn(git), resultTurn(mergedResult)]);
        const { runner, coordination } = yield* checkoutProgram([], { run: harness.run });

        yield* runner.execute(checkoutAdmission);
        yield* setOperation(git, personMerge);
        yield* next(runner);

        const attempts = yield* Ref.get(coordination.attempts);
        assert.lengthOf(yield* Ref.get(harness.visits), 1);
        assert.include(attempts.at(-1)?.reason ?? "", "has a merge in progress");
      }).pipe(Effect.provide(worktreeTestLayer), Effect.scoped),
    ),
  );

  it.effect("removes the record of a merge a person finishes before the next Run", () =>
    Effect.gen(function* () {
      const git = yield* WorktreeGit;
      const recordDuringRun = Stream.unwrap(
        Effect.map(Ref.get(git), ({ record }) => {
          const summary = `record: ${record?.operation ?? "none"}`;
          return resultTurn({ ...mergedResult, summary, inputs: { notification: summary } });
        }),
      );
      const harness = yield* scriptedHarness([afterMerge(git, resultTurn(stuckResult)), recordDuringRun]);
      const { runner, notifications } = yield* checkoutProgram([], { run: harness.run });

      yield* runner.execute(checkoutAdmission);
      yield* setOperation(git, null);
      yield* runner.handBack({ item: checkoutAdmission.event.key, note: "I finished the merge" });
      yield* runner.execute(checkoutAdmission);

      assert.deepStrictEqual(
        (yield* notifications.list).map(({ summary }) => summary),
        ["record: none"],
      );
    }).pipe(Effect.provide(worktreeTestLayer), Effect.scoped),
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
