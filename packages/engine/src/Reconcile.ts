import type {
  ClaimedItem,
  NeedsHumanItem,
  PollState,
  WorkItemId,
  WorkspaceId,
} from "@clanker-forge/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import { type Classification, classify, type EligibleWork } from "./classify";
import type { RegisteredWorkspace } from "./projector";
import { WorkspaceRegistry } from "./Registry";
import { type ObservedItem, WorkSource } from "./WorkSource";

export interface ObservedRef {
  readonly id: WorkItemId;
  readonly title: string;
}

export interface ReconcileReceipt {
  readonly workspaces: number;
  readonly failures: number;
  readonly pendingWork: number;
  readonly paused: number;
}

export interface WorkspaceReconcileState {
  readonly name: WorkspaceId;
  readonly poll: PollState;
  readonly eligible: ReadonlyArray<EligibleWork>;
  readonly claimed: ReadonlyArray<ClaimedItem>;
  readonly needsHuman: ReadonlyArray<NeedsHumanItem>;
  readonly observed: ReadonlyArray<ObservedRef>;
}

export interface ReconcileSnapshot {
  readonly generation: number;
  readonly workspaces: ReadonlyArray<WorkspaceReconcileState>;
}

interface ReconcileJob {
  readonly receipt: Deferred.Deferred<ReconcileReceipt>;
}

const okState = (
  workspace: RegisteredWorkspace,
  observed: ReadonlyArray<ObservedItem>,
  classified: Classification,
): WorkspaceReconcileState => ({
  name: workspace.config.name,
  poll: { status: "ok" },
  eligible: classified.eligible,
  claimed: classified.claimed,
  needsHuman: classified.needsHuman,
  observed: observed.map((item) => ({ id: item.id, title: item.title })),
});

const pausedState = (workspace: RegisteredWorkspace, message: string): WorkspaceReconcileState => ({
  name: workspace.config.name,
  poll: { status: "paused", message },
  eligible: [],
  claimed: [],
  needsHuman: [],
  observed: [],
});

export const make = Effect.gen(function* () {
  const registry = yield* WorkspaceRegistry;
  const workSource = yield* WorkSource;
  const queue = yield* Queue.make<ReconcileJob>();
  const snapshotRef = yield* Ref.make<ReconcileSnapshot>({ generation: 0, workspaces: [] });

  const pollWorkspace = (workspace: RegisteredWorkspace) =>
    workSource.observe(workspace).pipe(
      Effect.map((items) => okState(workspace, items, classify(items))),
      Effect.catchTag("WorkSourceError", (error) =>
        Effect.gen(function* () {
          yield* Effect.logWarning("work source polling paused", {
            workspace: workspace.config.name,
            reason: error.reason,
            message: error.message,
          });
          return pausedState(workspace, error.message);
        }),
      ),
    );

  const reconcile = Effect.fn("ReconcileWorker.reconcile")(function* (job: ReconcileJob) {
    const states = yield* Effect.forEach(registry.workspaces, pollWorkspace, {
      concurrency: 4,
    });
    yield* Ref.update(snapshotRef, (previous) => ({
      generation: previous.generation + 1,
      workspaces: states,
    }));
    yield* Deferred.succeed(job.receipt, {
      workspaces: registry.workspaces.length,
      failures: registry.failures.length,
      pendingWork: states.reduce((total, state) => total + state.eligible.length, 0),
      paused: states.filter((state) => state.poll.status === "paused").length,
    });
  });

  yield* Queue.take(queue).pipe(Effect.flatMap(reconcile), Effect.forever, Effect.forkScoped);

  const submit = Effect.fn("ReconcileWorker.submit")(function* () {
    const receipt = yield* Deferred.make<ReconcileReceipt>();
    yield* Queue.offer(queue, { receipt });
    return yield* Deferred.await(receipt);
  });

  return { submit, snapshot: Ref.get(snapshotRef) } as const;
});

export class ReconcileWorker extends Context.Service<ReconcileWorker, Effect.Success<typeof make>>()(
  "@clanker-forge/engine/Reconcile/ReconcileWorker",
) {}

export const layer = Layer.effect(ReconcileWorker, make);
