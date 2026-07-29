import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import { WorkspaceRegistry } from "./Registry";

export interface ReconcileReceipt {
  readonly workspaces: number;
  readonly failures: number;
}

interface ReconcileJob {
  readonly receipt: Deferred.Deferred<ReconcileReceipt>;
}

export const make = Effect.gen(function* () {
  const registry = yield* WorkspaceRegistry;
  const queue = yield* Queue.make<ReconcileJob>();

  yield* Queue.take(queue).pipe(
    Effect.flatMap((job) =>
      Deferred.succeed(job.receipt, {
        workspaces: registry.workspaces.length,
        failures: registry.failures.length,
      }),
    ),
    Effect.forever,
    Effect.forkScoped,
  );

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
