import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import { WorkspaceRegistry } from "./Registry";
import { WorkSource } from "./workSource";

export interface ReconcileReceipt {
  readonly workspaces: number;
  readonly failures: number;
  readonly pendingWork: number;
}

interface ReconcileJob {
  readonly receipt: Deferred.Deferred<ReconcileReceipt>;
}

export const make = Effect.gen(function* () {
  const registry = yield* WorkspaceRegistry;
  const workSource = yield* WorkSource;
  const queue = yield* Queue.make<ReconcileJob>();

  const reconcile = Effect.fn("ReconcileWorker.reconcile")(function* (job: ReconcileJob) {
    const pending = yield* Effect.forEach(registry.workspaces, (workspace) => workSource.pending(workspace));
    yield* Deferred.succeed(job.receipt, {
      workspaces: registry.workspaces.length,
      failures: registry.failures.length,
      pendingWork: pending.reduce((total, items) => total + items.length, 0),
    });
  });

  yield* Queue.take(queue).pipe(Effect.flatMap(reconcile), Effect.forever, Effect.forkScoped);

  const submit = Effect.fn("ReconcileWorker.submit")(function* () {
    const receipt = yield* Deferred.make<ReconcileReceipt>();
    yield* Queue.offer(queue, { receipt });
    return yield* Deferred.await(receipt);
  });

  return { submit } as const;
});

export class ReconcileWorker extends Context.Service<ReconcileWorker, Effect.Success<typeof make>>()(
  "engine/reconcile/ReconcileWorker",
) {}

export const layer = Layer.effect(ReconcileWorker, make);
