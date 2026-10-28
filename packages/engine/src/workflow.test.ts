import { localOwner, Principal, validateWorkflowInput, WorkflowDocument } from "@cogwork/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
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
});
