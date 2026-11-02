import { DatabaseSync } from "node:sqlite";
import {
  availabilityOf,
  localOwner,
  MachineReadiness,
  Principal,
  WorkflowCatalogEntry,
  type WorkflowCatalogKey,
  WorkflowDocument,
  WorkflowEditRefused,
  WorkflowNodeId,
  WorkflowNotFound,
  WorkflowPublishRefused,
  WorkflowSwitchRefused,
  WorkflowUnreadable,
  type WorkspaceId,
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
import { clockEntries, clockSource } from "./clock-source";
import { bootControlStoreLayer } from "./control-store";
import * as DaemonEventBus from "./daemon-event-bus";
import { githubSourceControlActionEntries, slackReviewTemplate } from "./github/provider";
import { granolaWorkflowCatalogContribution } from "./granola-source";
import * as Harness from "./harness";
import { issueTrackerWorkflowCatalogContribution } from "./issue-workflow-catalog";
import { slackEntries } from "./slack-source";
import { slackActionEntries } from "./slack-write";
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
  connections: [
    { system: "github", ready: true, reason: null },
    { system: "granola", ready: false, reason: "Granola login expired" },
  ],
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
  templates: [slackReviewTemplate],
};

const clockContribution = {
  entries: clockEntries,
  templates: [],
  listOptions: (entry: WorkflowCatalogKey, parameter: string, workspaces: ReadonlyArray<WorkspaceId>) =>
    clockSource.listOptions(entry, parameter).pipe(
      Effect.map((options) => options.map((option) => ({ ...option, listedIn: workspaces }))),
      Effect.catchTag("SourceFailure", () => Effect.succeed([])),
    ),
};

const githubReviewContribution: WorkflowCatalogContribution = {
  entries: [...githubSourceControlActionEntries, ...slackEntries, ...slackActionEntries],
  templates: [],
  listOptions: () => Effect.succeed([]),
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
  issueTrackerWorkflowCatalogContribution("github"),
  issueTrackerWorkflowCatalogContribution("linear"),
  triggerContribution,
  granolaWorkflowCatalogContribution,
  githubReviewContribution,
  clockContribution,
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
  it.effect("lists both Granola Triggers with Connection availability", () =>
    Effect.gen(function* () {
      const storePath = yield* temporaryStore();
      const result = yield* withWorkflows(storePath, ({ catalog }) => catalog);
      const entries = result.catalog.entries.filter(({ system }) => system === "granola");

      assert.deepStrictEqual(
        entries.map(({ name }) => name),
        ["Note generated", "Note edited"],
      );
      assert.deepStrictEqual(
        entries.map((entry) => availabilityOf(entry, result.machine)),
        [
          { _tag: "Unavailable", reason: "Granola login expired" },
          { _tag: "Unavailable", reason: "Granola login expired" },
        ],
      );
    }),
  );

  it.effect("creates and publishes every shipped Workflow template", () =>
    Effect.gen(function* () {
      const storePath = yield* temporaryStore();
      const templates = yield* withWorkflows(storePath, ({ templates }) => templates);

      assert.deepStrictEqual(
        templates.map(({ id, document }) => ({
          id: String(id),
          trigger: String(document.triggers[0]?.entry),
          forEach: document.operations[0]?.forEach,
          choices: document.operations[0]?.questions[0]?.choices.map(({ id }) => String(id)),
          actions: document.operations[0]?.transitions.map(({ when, actions }) => ({
            choice: String(when[0]?.choice),
            entry: String(actions[0]?.entry),
            parameters: actions[0]?.parameters.map(({ id, value }) => ({ id: String(id), value })),
          })),
        })),
        [
          {
            id: "granola-to-github-issue",
            trigger: "granola.note-generated",
            forEach: "commitment",
            choices: ["new", "duplicate", "related"],
            actions: [
              {
                choice: "new",
                entry: "github.create-issue",
                parameters: [{ id: "label", value: "needs-triage" }],
              },
              { choice: "duplicate", entry: "github.comment-issue", parameters: [] },
              { choice: "related", entry: "github.comment-issue", parameters: [] },
            ],
          },
          {
            id: "github-staleness-sweep",
            trigger: "schedule.sweep",
            forEach: null,
            choices: ["keep", "retire", "refresh"],
            actions: [
              { choice: "keep", entry: "cogwork.stop", parameters: [] },
              { choice: "retire", entry: "cogwork.wait-for-approval", parameters: [] },
              {
                choice: "refresh",
                entry: "github.add-label",
                parameters: [{ id: "label", value: "needs-triage" }],
              },
            ],
          },
          {
            id: "granola-to-linear-issue",
            trigger: "granola.note-generated",
            forEach: "commitment",
            choices: ["new", "duplicate", "related"],
            actions: [
              {
                choice: "new",
                entry: "linear.create-issue",
                parameters: [{ id: "label", value: "state:needs-triage" }],
              },
              { choice: "duplicate", entry: "linear.comment-issue", parameters: [] },
              { choice: "related", entry: "linear.comment-issue", parameters: [] },
            ],
          },
          {
            id: "linear-staleness-sweep",
            trigger: "schedule.sweep",
            forEach: null,
            choices: ["keep", "retire", "refresh"],
            actions: [
              { choice: "keep", entry: "cogwork.stop", parameters: [] },
              { choice: "retire", entry: "cogwork.wait-for-approval", parameters: [] },
              {
                choice: "refresh",
                entry: "linear.add-label",
                parameters: [{ id: "label", value: "state:needs-triage" }],
              },
            ],
          },
          {
            id: "slack-to-github-review",
            trigger: "slack.i-am-mentioned",
            forEach: null,
            choices: ["review-request", "question", "not-actionable"],
            actions: [
              {
                choice: "review-request",
                entry: "slack.add-reaction",
                parameters: [{ id: "emoji", value: "eyes" }],
              },
              { choice: "question", entry: "slack.draft-reply-in-slack", parameters: [] },
              { choice: "not-actionable", entry: "cogwork.stop", parameters: [] },
            ],
          },
        ],
      );
      yield* Effect.forEach(templates, (template) => {
        assert.deepStrictEqual(template.document.workspaces, { _tag: "Every" });
        assert.isTrue(
          template.document.operations.every(
            ({ model }) => model.harness === null && model.model === null && model.options.length === 0,
          ),
        );
        return withWorkflows(storePath, ({ create, publish }) =>
          create({ document: template.document }).pipe(
            Effect.tap((created) =>
              Effect.sync(() =>
                assert.isFalse(
                  created.diagnostics.some(
                    ({ class: diagnosticClass }) =>
                      diagnosticClass === "malformed" || diagnosticClass === "incomplete",
                  ),
                ),
              ),
            ),
            Effect.flatMap((created) => publish({ id: created.id, revision: created.workingRevision })),
          ),
        );
      });
    }),
  );

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

      assert.deepStrictEqual(result.catalog.instructionPackages, [
        "triage-agent",
        "implement-agent",
        "follow-up-agent",
      ]);
      assert.deepStrictEqual(result.machine, machine);
    }),
  );

  it.effect("routes every Staleness sweep verdict", () =>
    Effect.gen(function* () {
      const storePath = yield* temporaryStore();
      const templates = (yield* withWorkflows(storePath, ({ templates }) => templates)).filter(({ id }) =>
        String(id).endsWith("-staleness-sweep"),
      );

      assert.deepStrictEqual(
        templates.map(({ id }) => id),
        ["github-staleness-sweep", "linear-staleness-sweep"],
      );
      assert.deepStrictEqual(
        templates.map(({ id, document }) => ({
          id,
          verdicts: document.operations[0]?.questions[0]?.choices.map(({ id: verdict }) => verdict),
          routes: document.operations[0]?.transitions.map(({ actions }) =>
            actions.map(({ entry, parameters }) =>
              [entry, ...parameters.map(({ value }) => value)].join(":"),
            ),
          ),
        })),
        [
          {
            id: "github-staleness-sweep",
            verdicts: ["keep", "retire", "refresh"],
            routes: [
              ["cogwork.stop"],
              ["cogwork.wait-for-approval", "github.comment-this-item", "github.close-this-issue"],
              ["github.add-label:needs-triage"],
            ],
          },
          {
            id: "linear-staleness-sweep",
            verdicts: ["keep", "retire", "refresh"],
            routes: [
              ["cogwork.stop"],
              ["cogwork.wait-for-approval", "linear.comment-this-item", "linear.close-this-issue"],
              ["linear.add-label:state:needs-triage"],
            ],
          },
        ],
      );
    }),
  );

  it.effect("lists live schedule zones through the Workflow catalog", () =>
    Effect.gen(function* () {
      const storePath = yield* temporaryStore();
      const options = yield* withWorkflows(storePath, ({ listOptions }) =>
        listOptions({
          entry: Schema.decodeSync(WorkflowCatalogEntry.fields.key)("schedule.daily"),
          parameter: "zone",
          workspaces: [],
        }),
      );

      assert.include(
        options.map(({ value }) => value),
        "America/New_York",
      );
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
