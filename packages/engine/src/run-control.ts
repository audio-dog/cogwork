import type { RunId } from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Option from "effect/Option";
import type { WorkspaceIssueTrackerBinding } from "./projector";

interface Registration {
  readonly fiber: Fiber.Fiber<unknown, unknown>;
  readonly workspace: WorkspaceIssueTrackerBinding | undefined;
}

export type RunCancellation = Data.TaggedEnum<{
  NotFound: { readonly run?: never };
  Interrupting: {
    readonly workspace: Option.Option<WorkspaceIssueTrackerBinding>;
    readonly awaitTermination: Effect.Effect<void>;
  };
}>;

export const RunCancellation = Data.taggedEnum<RunCancellation>();

export const make = Effect.gen(function* () {
  const fibers = yield* FiberMap.make<RunId>();
  const registrations = MutableHashMap.empty<RunId, Registration>();

  const forget = (runId: RunId, fiber: Fiber.Fiber<unknown, unknown>) => {
    const current = MutableHashMap.get(registrations, runId);
    if (Option.isSome(current) && current.value.fiber === fiber) {
      MutableHashMap.remove(registrations, runId);
    }
  };

  return {
    run: <A, E, R>(
      runId: RunId,
      workspace: WorkspaceIssueTrackerBinding | undefined,
      effect: Effect.Effect<A, E, R>,
    ) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const ready = yield* Deferred.make<void>();
          const fiber = yield* FiberMap.run(
            fibers,
            runId,
            restore(Deferred.await(ready).pipe(Effect.andThen(effect))),
          );
          yield* Effect.sync(() => {
            const current = FiberMap.getUnsafe(fibers, runId);
            if (Option.isSome(current) && current.value === fiber) {
              MutableHashMap.set(registrations, runId, { fiber, workspace });
              fiber.addObserver(() => forget(runId, fiber));
            }
          });
          yield* Deferred.succeed(ready, undefined);
          return yield* restore(Fiber.join(fiber)).pipe(
            Effect.onInterrupt(() => Effect.sync(() => fiber.interruptUnsafe(Fiber.getCurrent()?.id))),
          );
        }),
      ),
    cancel: Effect.fn("RunControl.cancel")(function* (runId: RunId) {
      return yield* Effect.sync(() => {
        const current = FiberMap.getUnsafe(fibers, runId);
        if (Option.isNone(current)) return RunCancellation.NotFound({});
        const fiber = current.value;
        const workspace = MutableHashMap.get(registrations, runId).pipe(
          Option.filter((registration) => registration.fiber === fiber),
          Option.flatMap((registration) => Option.fromNullishOr(registration.workspace)),
        );
        fiber.interruptUnsafe(Fiber.getCurrent()?.id);
        return RunCancellation.Interrupting({
          workspace,
          awaitTermination: Fiber.await(fiber).pipe(Effect.asVoid),
        });
      });
    }),
  };
});

export type RunControlService = Effect.Success<typeof make>;

export class RunControl extends Context.Service<RunControl, RunControlService>()(
  "@cogwork/engine/run-control/RunControl",
) {}

export const layer = Layer.effect(RunControl, make);
