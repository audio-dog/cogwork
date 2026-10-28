import { DatabaseSync } from "node:sqlite";
import {
  localOwnerId,
  WorkflowCatalog,
  WorkflowDocument,
  WorkflowEditRefused,
  WorkflowOperation,
  WorkflowPublishRefused,
  WorkflowSwitchRefused,
  WorkflowUnreadable,
} from "@cogwork/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { bootControlStoreLayer, WorkflowStore } from "./control-store";

const decodeDocument = Schema.decodeUnknownSync(WorkflowDocument);
const decodeCatalog = Schema.decodeUnknownSync(WorkflowCatalog);
const decodeOperation = Schema.decodeUnknownSync(WorkflowOperation);

const catalog = decodeCatalog({
  entries: [
    {
      key: "github.issue-opened",
      name: "Issue opened",
      kind: "trigger",
      system: "github",
      connection: null,
      requires: [],
      parameters: [],
      itemKind: "issue",
      actsOn: [],
      requiresWorkspace: false,
      permissionProfile: "read-only",
      agentInputs: [],
      emits: [],
    },
    {
      key: "cogwork.stop",
      name: "Stop",
      kind: "action",
      system: null,
      connection: null,
      requires: [],
      parameters: [],
      itemKind: null,
      actsOn: ["*"],
      requiresWorkspace: false,
      permissionProfile: "read-only",
      agentInputs: [],
      emits: [],
    },
  ],
  instructionPackages: [],
  models: [],
  defaultHarness: null,
  registeredWorkspaces: [],
  systemBindings: [],
  readyConnections: [],
  readyNeeds: [],
});

const operation = decodeOperation({
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
});

const completeDocument = decodeDocument({
  name: "Complete",
  workspaces: { _tag: "Every" },
  triggers: [{ id: "start", entry: "github.issue-opened", parameters: [], start: "run" }],
  operations: [operation],
});

const incompleteDocument = decodeDocument({ ...completeDocument, triggers: [] });

const temporaryStore = Effect.fn("test.temporaryWorkflowStore")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-workflow-store-" });
  return path.join(dir, "control.db");
});

const withStore = <A, E, R>(
  storePath: string,
  use: (store: typeof WorkflowStore.Service) => Effect.Effect<A, E, R>,
) => Effect.flatMap(WorkflowStore, use).pipe(Effect.provide(bootControlStoreLayer(storePath)));

const corruptWorkingCopy = (storePath: string, id: string) =>
  Effect.acquireUseRelease(
    Effect.sync(() => new DatabaseSync(storePath)),
    (database) =>
      Effect.sync(() => database.prepare("UPDATE workflows SET working_copy = '{}' WHERE id = ?").run(id)),
    (database) => Effect.sync(() => database.close()),
  );

layer(NodeServices.layer)((it) => {
  it.effect("keeps an incomplete working copy and refuses to publish it", () =>
    Effect.gen(function* () {
      const storePath = yield* temporaryStore();
      const record = yield* withStore(storePath, (store) =>
        store.createWorkflow(localOwnerId, incompleteDocument, catalog),
      );

      assert.include(
        record.diagnostics.map(({ code }) => code),
        "no-trigger",
      );
      const failure = yield* Effect.flip(
        withStore(storePath, (store) => store.publishWorkflow(record.id, record.workingRevision, catalog)),
      );
      assert.isTrue(Schema.is(WorkflowPublishRefused)(failure));
      if (!Schema.is(WorkflowPublishRefused)(failure)) return;
      assert.strictEqual(failure.reason, "incomplete");
    }),
  );

  it.effect("refuses a malformed edit batch without changing the working copy", () =>
    Effect.gen(function* () {
      const storePath = yield* temporaryStore();
      const created = yield* withStore(storePath, (store) =>
        store.createWorkflow(localOwnerId, completeDocument, catalog),
      );
      const result = yield* Effect.result(
        withStore(storePath, (store) =>
          store.editWorkflow(
            created.id,
            [
              { _tag: "SetName", name: "Changed" },
              {
                _tag: "ReplaceOperation",
                id: operation.id,
                operation: decodeOperation({ ...operation, id: "renamed" }),
              },
            ],
            catalog,
          ),
        ),
      );

      assert.isTrue(Result.isFailure(result));
      if (!Result.isFailure(result)) return;
      const failure = result.failure;
      assert.isTrue(Schema.is(WorkflowEditRefused)(failure));
      const unchanged = yield* withStore(storePath, (store) => store.getWorkflow(created.id, catalog));
      assert.strictEqual(unchanged.workingRevision, 1);
      assert.deepStrictEqual(unchanged.workingCopy, completeDocument);
    }),
  );

  it.effect("refuses a stale publish and switching on before publish", () =>
    Effect.gen(function* () {
      const storePath = yield* temporaryStore();
      const created = yield* withStore(storePath, (store) =>
        store.createWorkflow(localOwnerId, completeDocument, catalog),
      );
      const edited = yield* withStore(storePath, (store) =>
        store.editWorkflow(created.id, [{ _tag: "SetName", name: "Edited" }], catalog),
      );
      const stale = yield* Effect.flip(
        withStore(storePath, (store) => store.publishWorkflow(created.id, 1, catalog)),
      );
      const switchFailure = yield* Effect.flip(
        withStore(storePath, (store) => store.switchWorkflow(created.id, true, catalog)),
      );

      assert.isTrue(Schema.is(WorkflowPublishRefused)(stale));
      if (Schema.is(WorkflowPublishRefused)(stale)) {
        assert.strictEqual(stale.reason, "stale-revision");
        assert.strictEqual(stale.actualRevision, edited.workingRevision);
      }
      assert.isTrue(Schema.is(WorkflowSwitchRefused)(switchFailure));
    }),
  );

  it.effect("publishes, switches, and deletes a Workflow", () =>
    Effect.gen(function* () {
      const storePath = yield* temporaryStore();
      const created = yield* withStore(storePath, (store) =>
        store.createWorkflow(localOwnerId, completeDocument, catalog),
      );
      const published = yield* withStore(storePath, (store) =>
        store.publishWorkflow(created.id, created.workingRevision, catalog),
      );
      const enabled = yield* withStore(storePath, (store) => store.switchWorkflow(created.id, true, catalog));
      const deleted = yield* withStore(storePath, (store) => store.deleteWorkflow(created.id));

      assert.strictEqual(published.publishedRevision, created.workingRevision);
      assert.isTrue(enabled.enabled);
      assert.strictEqual(deleted, created.id);
      assert.deepStrictEqual(yield* withStore(storePath, (store) => store.listWorkflows(catalog)), {
        workflows: [],
        failures: [],
      });
    }),
  );

  it.effect("reports one unreadable row while other Workflows load", () =>
    Effect.gen(function* () {
      const storePath = yield* temporaryStore();
      const first = yield* withStore(storePath, (store) =>
        store.createWorkflow(localOwnerId, completeDocument, catalog),
      );
      const second = yield* withStore(storePath, (store) =>
        store.createWorkflow(localOwnerId, completeDocument, catalog),
      );
      yield* corruptWorkingCopy(storePath, first.id);

      const listed = yield* withStore(storePath, (store) => store.listWorkflows(catalog));
      assert.deepStrictEqual(
        listed.workflows.map(({ id }) => id),
        [second.id],
      );
      assert.deepStrictEqual(
        listed.failures.map(({ id }) => id),
        [first.id],
      );
      const failure = yield* Effect.flip(
        withStore(storePath, (store) => store.getWorkflow(first.id, catalog)),
      );
      assert.isTrue(Schema.is(WorkflowUnreadable)(failure));
    }),
  );
});
