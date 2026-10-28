import { localOwner, Principal, validateWorkflowInput, WorkflowDocument } from "@cogwork/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, layer } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { bootControlStoreLayer } from "./control-store";
import * as DaemonEventBus from "./daemon-event-bus";
import { createWorkflow, deleteWorkflow, validateWorkflowDocument } from "./workflow";
import { workflowCatalog } from "./workflow-catalog";

const document = Schema.decodeSync(WorkflowDocument)({
  name: "Incomplete",
  workspaces: { _tag: "Every" },
  triggers: [],
  operations: [],
});

const temporaryStore = Effect.fn("test.temporaryWorkflowEventStore")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-workflow-events-" });
  return path.join(dir, "control.db");
});

class WorkflowPublicationProbe extends Context.Service<
  WorkflowPublicationProbe,
  {
    readonly started: Deferred.Deferred<void>;
    readonly release: Deferred.Deferred<void>;
    readonly published: Ref.Ref<number>;
  }
>()("@cogwork/engine/workflow.test/WorkflowPublicationProbe") {
  static readonly layer = Layer.effect(
    WorkflowPublicationProbe,
    Effect.all({
      started: Deferred.make<void>(),
      release: Deferred.make<void>(),
      published: Ref.make(0),
    }),
  );

  static readonly busLayer = Layer.effect(
    DaemonEventBus.DaemonEventBus,
    Effect.gen(function* () {
      const bus = yield* DaemonEventBus.make;
      const probe = yield* WorkflowPublicationProbe;
      const publish: DaemonEventBus.DaemonEventBusService["publish"] = () =>
        Deferred.succeed(probe.started, undefined).pipe(
          Effect.andThen(Deferred.await(probe.release)),
          Effect.andThen(Ref.update(probe.published, (count) => count + 1)),
          Effect.map(() => true),
        );
      return { ...bus, publish };
    }),
  ).pipe(Layer.provideMerge(WorkflowPublicationProbe.layer));
}

const assertWorkflowEvents = Effect.fn("test.assertWorkflowEvents")(function* () {
  const bus = yield* DaemonEventBus.DaemonEventBus;
  const events = yield* Effect.forkChild(Stream.runCollect(Stream.take(bus.events, 2)), {
    startImmediately: true,
  });
  yield* Effect.yieldNow;
  const created = yield* createWorkflow({ document });
  yield* deleteWorkflow({ id: created.id });

  const received = [...(yield* Fiber.join(events))];
  assert.strictEqual(received[0]?._tag, "WorkflowChanged");
  if (received[0]?._tag === "WorkflowChanged") {
    assert.deepStrictEqual(received[0].workflow, created);
  }
  assert.strictEqual(received[1]?._tag, "WorkflowDeleted");
  if (received[1]?._tag === "WorkflowDeleted") {
    assert.strictEqual(received[1].id, created.id);
  }
});

layer(NodeServices.layer)((it) => {
  it.effect("returns the pure validator's diagnostics for malformed input", () =>
    Effect.gen(function* () {
      const input = { name: "Missing every other field" };
      assert.deepStrictEqual(
        yield* validateWorkflowDocument({ document: input }),
        validateWorkflowInput(input, workflowCatalog),
      );
    }),
  );

  it.effect("publishes the whole changed record and the deleted id", () =>
    temporaryStore().pipe(
      Effect.flatMap((storePath) =>
        assertWorkflowEvents().pipe(
          Effect.provide(
            Layer.mergeAll(
              bootControlStoreLayer(storePath),
              DaemonEventBus.layer,
              Layer.succeed(Principal, localOwner),
            ),
          ),
          Effect.scoped,
        ),
      ),
    ),
  );

  it.effect("publishes a committed Workflow after the caller disconnects", () =>
    temporaryStore().pipe(
      Effect.flatMap((storePath) =>
        Effect.gen(function* () {
          const probe = yield* WorkflowPublicationProbe;
          const creating = yield* Effect.forkChild(createWorkflow({ document }));
          yield* Deferred.await(probe.started);
          const interrupting = yield* Effect.forkChild(Fiber.interrupt(creating));
          yield* Effect.yieldNow;
          yield* Deferred.succeed(probe.release, undefined);
          yield* Fiber.join(interrupting);

          assert.strictEqual(yield* Ref.get(probe.published), 1);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              bootControlStoreLayer(storePath),
              WorkflowPublicationProbe.busLayer,
              Layer.succeed(Principal, localOwner),
            ),
          ),
          Effect.scoped,
        ),
      ),
    ),
  );
});
