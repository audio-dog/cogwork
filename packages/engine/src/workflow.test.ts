import { DatabaseSync } from "node:sqlite";
import {
  localOwner,
  MachineReadiness,
  Principal,
  WorkflowCatalogEntry,
  WorkflowDocument,
  WorkflowEditRefused,
  WorkflowNodeId,
  WorkflowNotFound,
  WorkflowPublishRefused,
  WorkflowSwitchRefused,
  WorkflowUnreadable,
} from "@cogwork/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, layer } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { bootControlStoreLayer } from "./control-store";
import * as DaemonEventBus from "./daemon-event-bus";
import * as Harness from "./harness";
import { Workflows, layer as workflowsLayer } from "./workflow";
import {
  cogworkWorkflowCatalogContribution,
  type WorkflowCatalogContribution,
  WorkflowCatalogContributions,
} from "./workflow-catalog";
import * as MachineReadinessSource from "./workflow-machine-readiness";

const decodeDocument = Schema.decodeUnknownSync(WorkflowDocument);
const decodeEntry = Schema.decodeUnknownSync(WorkflowCatalogEntry);
const machine = Schema.decodeSync(MachineReadiness)({
  workspaces: [{ id: "cogwork", binds: ["github"] }],
  connections: [{ system: "github", ready: true, reason: null }],
  harnesses: [],
  defaultHarness: null,
  readyNeeds: [],
});

const triggerContribution: WorkflowCatalogContribution = {
  entries: [
    decodeEntry({
      key: "github.issue-opened",
      name: "Issue opened",
      kind: "trigger",
      system: "github",
      connection: "github/main",
      requires: [],
      parameters: [],
      itemKind: "issue",
      actsOn: [],
      requiresWorkspace: false,
      permissionProfile: "read-only",
      agentInputs: [],
      emits: [],
    }),
  ],
  templates: [],
};

const document = decodeDocument({
  name: "Complete",
  workspaces: { _tag: "Every" },
  triggers: [{ id: "start", entry: "github.issue-opened", parameters: [], start: "run" }],
  operations: [
    {
      id: "run",
      name: "Run",
      instructionPackage: null,
      instruction: "Do the work.",
      permissionProfile: "read-only",
      requires: [],
      model: { harness: null, model: null, options: [] },
      forEach: null,
      questions: [],
      transitions: [{ when: [], actions: [{ entry: "cogwork.stop", parameters: [] }], handOff: null }],
      hints: [],
    },
  ],
});

const incompleteDocument = decodeDocument({ ...document, triggers: [] });
const trigger = document.triggers[0];
if (!trigger) throw new Error("missing test Trigger");
const operation = document.operations[0];
if (!operation) throw new Error("missing test Operation");

const temporaryStore = Effect.fn("test.temporaryWorkflowsStore")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-workflows-" });
  return path.join(dir, "control.db");
});

const catalogLayer = Layer.succeed(WorkflowCatalogContributions, [
  cogworkWorkflowCatalogContribution,
  triggerContribution,
]);

const testLayer = (
  storePath: string,
  busLayer: Layer.Layer<DaemonEventBus.DaemonEventBus> = DaemonEventBus.layer,
) => {
  const controlStore = bootControlStoreLayer(storePath);
  const readiness = MachineReadinessSource.testLayer(machine);
  const harness = Harness.layer([]);
  const workflows = workflowsLayer.pipe(
    Layer.provide(catalogLayer),
    Layer.provide(readiness),
    Layer.provide(Layer.mergeAll(controlStore, busLayer, harness)),
  );
  return Layer.mergeAll(workflows, busLayer, controlStore, readiness, Layer.succeed(Principal, localOwner));
};

const withWorkflows = <A, E, R>(
  storePath: string,
  use: (workflows: typeof Workflows.Service) => Effect.Effect<A, E, R>,
) => Effect.flatMap(Workflows, use).pipe(Effect.provide(testLayer(storePath)));

const corruptStoredRow = (storePath: string, id: string) =>
  Effect.acquireUseRelease(
    Effect.sync(() => new DatabaseSync(storePath)),
    (database) =>
      Effect.sync(() => database.prepare("UPDATE workflows SET enabled = 2 WHERE id = ?").run(id)),
    (database) => Effect.sync(() => database.close()),
  );

layer(NodeServices.layer)((it) => {
  it.effect("keeps an incomplete working copy and refuses to publish it", () =>
    Effect.gen(function* () {
      const storePath = yield* temporaryStore();
      const record = yield* withWorkflows(storePath, ({ create }) =>
        create({ document: incompleteDocument }),
      );

      assert.include(
        record.diagnostics.map(({ code }) => code),
        "no-trigger",
      );
      const failure = yield* Effect.flip(
        withWorkflows(storePath, ({ publish }) =>
          publish({ id: record.id, revision: record.workingRevision }),
        ),
      );
      assert.isTrue(Schema.is(WorkflowPublishRefused)(failure));
      if (!Schema.is(WorkflowPublishRefused)(failure)) return;
      assert.strictEqual(failure.reason, "incomplete");
    }),
  );

  it.effect("refuses a malformed edit batch without changing the working copy", () =>
    Effect.gen(function* () {
      const storePath = yield* temporaryStore();
      const created = yield* withWorkflows(storePath, ({ create }) => create({ document }));
      const result = yield* Effect.result(
        withWorkflows(storePath, ({ edit }) =>
          edit({
            id: created.id,
            edits: [
              { _tag: "Rename", name: "Changed" },
              {
                _tag: "SetTriggerStart",
                trigger: trigger.id,
                start: Schema.decodeSync(WorkflowNodeId)("missing"),
              },
            ],
          }),
        ),
      );

      assert.isTrue(Result.isFailure(result));
      if (!Result.isFailure(result)) return;
      assert.isTrue(Schema.is(WorkflowEditRefused)(result.failure));
      const unchanged = yield* withWorkflows(storePath, ({ get }) => get({ id: created.id }));
      assert.strictEqual(unchanged.workingRevision, 1);
      assert.deepStrictEqual(unchanged.workingCopy, document);
    }),
  );

  it.effect("refuses an unknown instruction package", () =>
    Effect.gen(function* () {
      const storePath = yield* temporaryStore();
      const created = yield* withWorkflows(storePath, ({ create }) => create({ document }));
      const refused = yield* Effect.flip(
        withWorkflows(storePath, ({ edit }) =>
          edit({
            id: created.id,
            edits: [
              {
                _tag: "SetInstructionPackage",
                operation: operation.id,
                package: "missing-agent",
              },
            ],
          }),
        ),
      );

      assert.isTrue(Schema.is(WorkflowEditRefused)(refused));
      if (!Schema.is(WorkflowEditRefused)(refused)) return;
      assert.deepStrictEqual(
        refused.diagnostics.map(({ code }) => code),
        ["unknown-catalog-entry"],
      );
    }),
  );

  it.effect("publishes a listed instruction package without inline text", () =>
    Effect.gen(function* () {
      const storePath = yield* temporaryStore();
      const created = yield* withWorkflows(storePath, ({ create }) => create({ document }));
      const edited = yield* withWorkflows(storePath, ({ edit }) =>
        edit({
          id: created.id,
          edits: [
            {
              _tag: "SetInstructionPackage",
              operation: operation.id,
              package: "implement-agent",
            },
            { _tag: "SetInstruction", operation: operation.id, instruction: "" },
          ],
        }),
      );
      const published = yield* withWorkflows(storePath, ({ publish }) =>
        publish({ id: created.id, revision: edited.workingRevision }),
      );

      assert.strictEqual(published.publishedCopy?.operations[0]?.instructionPackage, "implement-agent");
      assert.strictEqual(published.publishedCopy?.operations[0]?.instruction, "");
    }),
  );

  it.effect("publishes, switches, deletes, and emits whole records", () =>
    Effect.flatMap(temporaryStore(), (storePath) =>
      Effect.gen(function* () {
        const workflows = yield* Workflows;
        const bus = yield* DaemonEventBus.DaemonEventBus;
        const events = yield* Effect.forkChild(Stream.runCollect(Stream.take(bus.events, 5)), {
          startImmediately: true,
        });
        yield* Effect.yieldNow;

        const created = yield* workflows.create({ document });
        const edited = yield* workflows.edit({
          id: created.id,
          edits: [{ _tag: "Rename", name: "Edited" }],
        });
        const published = yield* workflows.publish({ id: created.id, revision: edited.workingRevision });
        const switched = yield* workflows.switch({ id: created.id, enabled: true });
        yield* workflows.delete({ id: created.id });
        const received = [...(yield* Fiber.join(events))];

        assert.strictEqual(published.publishedRevision, edited.workingRevision);
        assert.isTrue(switched.workflow.enabled);
        assert.deepStrictEqual(
          received.slice(0, 3).map((event) => (event._tag === "WorkflowChanged" ? event.workflow : null)),
          [created, edited, published],
        );
        assert.deepStrictEqual(
          received[3]?._tag === "WorkflowChanged" ? received[3].workflow : null,
          switched.workflow,
        );
        assert.strictEqual(received[4]?._tag, "WorkflowDeleted");
        if (received[4]?._tag === "WorkflowDeleted") {
          assert.strictEqual(received[4].id, created.id);
        }
      }).pipe(Effect.provide(testLayer(storePath))),
    ),
  );

  it.effect("publishes a committed Workflow after the caller disconnects", () =>
    Effect.all({
      storePath: temporaryStore(),
      started: Deferred.make<void>(),
      release: Deferred.make<void>(),
      published: Ref.make(0),
    }).pipe(
      Effect.flatMap(({ storePath, started, release, published }) => {
        const busLayer = Layer.effect(
          DaemonEventBus.DaemonEventBus,
          Effect.map(DaemonEventBus.make, (bus) => ({
            ...bus,
            publish: () =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(Ref.update(published, (count) => count + 1)),
                Effect.map(() => true),
              ),
          })),
        );
        return Effect.gen(function* () {
          const workflows = yield* Workflows;
          const creating = yield* Effect.forkChild(workflows.create({ document }));
          yield* Deferred.await(started);
          const interrupting = yield* Effect.forkChild(Fiber.interrupt(creating));
          yield* Effect.yieldNow;
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(interrupting);

          assert.strictEqual(yield* Ref.get(published), 1);
        }).pipe(Effect.provide(testLayer(storePath, busLayer)));
      }),
    ),
  );

  it.effect("refuses stale publish and switch-on before publish", () =>
    Effect.gen(function* () {
      const storePath = yield* temporaryStore();
      const created = yield* withWorkflows(storePath, ({ create }) => create({ document }));
      const edited = yield* withWorkflows(storePath, ({ edit }) =>
        edit({ id: created.id, edits: [{ _tag: "Rename", name: "Edited" }] }),
      );
      const stale = yield* Effect.flip(
        withWorkflows(storePath, ({ publish }) => publish({ id: created.id, revision: 1 })),
      );
      const switchFailure = yield* Effect.flip(
        withWorkflows(storePath, ({ switch: switchWorkflow }) =>
          switchWorkflow({ id: created.id, enabled: true }),
        ),
      );

      assert.isTrue(Schema.is(WorkflowPublishRefused)(stale));
      if (Schema.is(WorkflowPublishRefused)(stale)) {
        assert.strictEqual(stale.reason, "stale-revision");
        assert.strictEqual(stale.actualRevision, edited.workingRevision);
      }
      assert.isTrue(Schema.is(WorkflowSwitchRefused)(switchFailure));
    }),
  );

  it.effect("reports one unreadable row while other Workflows load", () =>
    Effect.gen(function* () {
      const storePath = yield* temporaryStore();
      const first = yield* withWorkflows(storePath, ({ create }) => create({ document }));
      const second = yield* withWorkflows(storePath, ({ create }) => create({ document }));
      yield* corruptStoredRow(storePath, first.id);

      const listed = yield* withWorkflows(storePath, ({ list }) => list);
      assert.deepStrictEqual(
        listed.workflows.map(({ id }) => id),
        [second.id],
      );
      assert.deepStrictEqual(
        listed.unreadable.map(({ id }) => id),
        [first.id],
      );
      const failure = yield* Effect.flip(withWorkflows(storePath, ({ get }) => get({ id: first.id })));
      assert.isTrue(Schema.is(WorkflowUnreadable)(failure));
    }),
  );

  it.effect("returns catalog content and machine state separately", () =>
    Effect.gen(function* () {
      const storePath = yield* temporaryStore();
      const result = yield* withWorkflows(storePath, ({ catalog }) => catalog);

      assert.lengthOf(result.catalog.entries, 6);
      assert.deepStrictEqual(result.catalog.instructionPackages, [
        "triage-agent",
        "implement-agent",
        "follow-up-agent",
      ]);
      assert.deepStrictEqual(result.machine, machine);
    }),
  );

  it.effect("refreshes readiness without blocking publish", () =>
    Effect.flatMap(temporaryStore(), (storePath) =>
      Effect.gen(function* () {
        const workflows = yield* Workflows;
        const readiness = yield* MachineReadinessSource.MachineReadinessTestState;
        const created = yield* workflows.create({ document });
        yield* Ref.update(readiness, (current) => ({ ...current, connections: [] }));
        const fetched = yield* workflows.get({ id: created.id });
        const published = yield* workflows.publish({ id: created.id, revision: created.workingRevision });

        assert.include(
          fetched.readiness.map(({ code }) => code),
          "connection-not-ready",
        );
        assert.strictEqual(published.publishedRevision, created.workingRevision);
      }).pipe(Effect.provide(testLayer(storePath))),
    ),
  );

  it.effect("reports a deleted Workflow as missing", () =>
    Effect.gen(function* () {
      const storePath = yield* temporaryStore();
      const created = yield* withWorkflows(storePath, ({ create }) => create({ document }));
      yield* withWorkflows(storePath, ({ delete: deleteWorkflow }) => deleteWorkflow({ id: created.id }));
      const missing = yield* Effect.exit(withWorkflows(storePath, ({ get }) => get({ id: created.id })));

      assert.isTrue(Exit.isFailure(missing));
      if (!Exit.isFailure(missing)) return;
      const failure = Option.getOrNull(Cause.findErrorOption(missing.cause));
      assert.isTrue(Schema.is(WorkflowNotFound)(failure));
    }),
  );
});
