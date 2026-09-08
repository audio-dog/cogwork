import { RunId, WorkspaceConfig, WorkspaceId } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import type { WorkspaceIssueTrackerBinding } from "./projector";
import * as RunControl from "./run-control";

const runId = Schema.decodeSync(RunId);
const workspaceId = Schema.decodeSync(WorkspaceId);
const workspace = {
  config: Schema.decodeSync(WorkspaceConfig)({
    name: workspaceId("example"),
    checkoutPath: "/repos/example",
    issueTracker: { type: "linear" },
  }),
} satisfies WorkspaceIssueTrackerBinding;

describe("RunControl", () => {
  it.effect("forgets a registered fiber after ordinary completion without releasing its claim", () =>
    Effect.gen(function* () {
      const control = yield* RunControl.RunControl;
      const released = MutableRef.make(false);

      yield* control.run(
        runId("run-1"),
        workspace,
        Effect.void,
        Effect.sync(() => MutableRef.set(released, true)),
      );

      assert.isFalse(MutableRef.get(released));
      assert.strictEqual((yield* control.cancel(runId("run-1")))._tag, "NotFound");
    }).pipe(Effect.provide(RunControl.layer), Effect.scoped),
  );

  it.effect("interrupts registered fibers when its layer closes without releasing their claims", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(RunControl.layer, scope);
      const control = Context.get(context, RunControl.RunControl);
      const started = yield* Deferred.make<void>();
      const released = MutableRef.make(false);
      const fiber = yield* Effect.forkChild(
        control.run(
          runId("run-1"),
          workspace,
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
          Effect.sync(() => MutableRef.set(released, true)),
        ),
      );
      yield* Deferred.await(started);

      yield* Scope.close(scope, Exit.void);

      const exit = yield* Fiber.await(fiber);
      assert.isTrue(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause));
      assert.isFalse(MutableRef.get(released));
    }),
  );

  it.effect("interrupts a registered fiber and releases its claim on manual cancellation", () =>
    Effect.gen(function* () {
      const control = yield* RunControl.RunControl;
      const started = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();
      const fiber = yield* Effect.forkChild(
        control.run(
          runId("run-1"),
          workspace,
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
          Deferred.succeed(released, undefined),
        ),
      );
      yield* Deferred.await(started);

      const cancellation = yield* control.cancel(runId("run-1"));
      assert.strictEqual(cancellation._tag, "Interrupting");
      if (cancellation._tag !== "Interrupting") return;

      assert.deepStrictEqual(cancellation.workspace, Option.some(workspace));
      yield* cancellation.awaitTermination;
      assert.isTrue(yield* Deferred.isDone(released));
      const exit = yield* Fiber.await(fiber);
      assert.isTrue(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause));
      assert.strictEqual((yield* control.cancel(runId("run-1")))._tag, "NotFound");
      assert.strictEqual((yield* control.cancel(runId("unknown")))._tag, "NotFound");
    }).pipe(Effect.provide(RunControl.layer), Effect.scoped),
  );

  it.effect("propagates caller interruption without releasing the claim", () =>
    Effect.gen(function* () {
      const control = yield* RunControl.RunControl;
      const started = yield* Deferred.make<void>();
      const released = MutableRef.make(false);
      const caller = yield* Effect.forkChild(
        control.run(
          runId("run-1"),
          workspace,
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
          Effect.sync(() => MutableRef.set(released, true)),
        ),
      );
      yield* Deferred.await(started);

      yield* Fiber.interrupt(caller);

      assert.isFalse(MutableRef.get(released));
      assert.strictEqual((yield* control.cancel(runId("run-1")))._tag, "NotFound");
    }).pipe(Effect.provide(RunControl.layer), Effect.scoped),
  );

  it.effect("keeps a replacement registered after cancellation starts", () =>
    Effect.gen(function* () {
      const control = yield* RunControl.RunControl;
      const replacementWorkspace = {
        config: { ...workspace.config, name: workspaceId("replacement") },
      } satisfies WorkspaceIssueTrackerBinding;
      const firstStarted = yield* Deferred.make<void>();
      const finishFirstTeardown = yield* Deferred.make<void>();
      const first = yield* Effect.forkChild(
        control.run(
          runId("run-1"),
          workspace,
          Deferred.succeed(firstStarted, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.await(finishFirstTeardown)),
          ),
        ),
      );
      yield* Deferred.await(firstStarted);

      const cancellation = yield* control.cancel(runId("run-1"));
      assert.strictEqual(cancellation._tag, "Interrupting");

      const replacementStarted = yield* Deferred.make<void>();
      const replacement = yield* Effect.forkChild(
        control.run(
          runId("run-1"),
          replacementWorkspace,
          Deferred.succeed(replacementStarted, undefined).pipe(Effect.andThen(Effect.never)),
        ),
      );
      yield* Deferred.await(replacementStarted);
      yield* Deferred.succeed(finishFirstTeardown, undefined);
      if (cancellation._tag === "Interrupting") yield* cancellation.awaitTermination;

      assert.isUndefined(replacement.pollUnsafe());
      const replacementCancellation = yield* control.cancel(runId("run-1"));
      assert.strictEqual(replacementCancellation._tag, "Interrupting");
      if (replacementCancellation._tag === "Interrupting") {
        assert.deepStrictEqual(replacementCancellation.workspace, Option.some(replacementWorkspace));
        yield* replacementCancellation.awaitTermination;
      }
      yield* Fiber.await(first);
    }).pipe(Effect.provide(RunControl.layer), Effect.scoped),
  );
});
