import {
  keyOf,
  RunId,
  WorkflowCatalogKey,
  WorkflowDocument,
  WorkflowId,
  WorkflowNodeId,
  WorkItemId,
  WorkspaceConfig,
} from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { Coordination, fold } from "./coordination";
import { IssueTracker, makeEmpty } from "./issue-tracker";
import { issueTrackerWorkflowCatalogContribution } from "./issue-workflow-catalog";
import type { RegisteredWorkspace } from "./projector";
import { SlackWrite } from "./slack-write";
import { engineTestLayer } from "./testing/engine-test-layer";
import {
  makeMemoryTriggerObservationStore,
  type TriggerAdmission,
  TriggerObservationStore,
} from "./trigger-observation";
import { buildWorkflowActionPlan, executeWorkflowActionPlan } from "./workflow-action-plan";
import {
  WorkflowActionPlanStore,
  memoryLayer as workflowActionPlanStoreLayer,
} from "./workflow-action-plan-store";
import { memoryLayer as workflowArtifactStoreLayer } from "./workflow-artifact-store";

const decodeEntry = Schema.decodeSync(WorkflowCatalogKey);
const operation = Schema.decodeSync(WorkflowNodeId)("write");
const workflow = Schema.decodeSync(WorkflowId)("issue-writes");
const issue = Schema.decodeSync(WorkItemId)("#899");
const attempt = Schema.decodeSync(RunId)("issue-plan");

const workspaces = {
  github: Schema.decodeSync(WorkspaceConfig)({
    name: "repo",
    checkoutPath: "/repo",
    issueTracker: { type: "github" },
  }),
  linear: Schema.decodeSync(WorkspaceConfig)({
    name: "team",
    checkoutPath: "/team",
    issueTracker: { type: "linear", teams: ["CGW"] },
  }),
} as const;

const admissionFor = (config: WorkspaceConfig): TriggerAdmission => {
  const ref = { _tag: "Issue", workspace: config.name, id: issue } as const;
  const entry = decodeEntry(`${config.issueTracker.type}.issue-changed`);
  return {
    event: {
      key: ref,
      revision: "1",
      cause: { _tag: "Unknown" },
      atMillis: 1,
      entry,
      workspace: config.name,
    },
    subscription: {
      workflow,
      trigger: Schema.decodeSync(WorkflowNodeId)("issue-changed"),
      operation,
      entry,
      parameters: [],
      filters: [],
      workspaces: [config.name],
      catchUp: { since: 0 },
    },
    lineage: {
      root: Schema.decodeSync(Schema.String.pipe(Schema.brand("LineageId")))(keyOf(ref)),
      parent: null,
      hop: 0,
    },
  };
};

const writesFor = (system: keyof typeof workspaces) => {
  const action = (id: string, label?: string) => ({
    entry: decodeEntry(`${system}.${id}`),
    parameters: label === undefined ? [] : [{ id: "label", value: label }],
  });
  return {
    id: operation,
    name: "Write",
    instructionPackage: null,
    instruction: "Write to the issue.",
    permissionProfile: "read-only",
    requires: [],
    model: { harness: null, model: null, options: [] },
    forEach: null,
    questions: [],
    transitions: [
      {
        when: [],
        actions: [
          action("comment-this-item"),
          action("add-label", "ready-for-agent"),
          action("remove-label", "needs-triage"),
          action("close-this-issue"),
        ],
        handOff: null,
      },
    ],
    hints: [],
  } as const;
};

class TrackerCalls extends Context.Service<TrackerCalls, Ref.Ref<ReadonlyArray<string>>>()(
  "@cogwork/engine/workflow-actions-issue.test/TrackerCalls",
) {
  static readonly layer = Layer.effect(TrackerCalls, Ref.make<ReadonlyArray<string>>([]));
}

const trackerLayer = Layer.effect(
  IssueTracker,
  Effect.gen(function* () {
    const calls = yield* TrackerCalls;
    const base = yield* makeEmpty;
    const record = (call: string) => Ref.update(calls, (current) => [...current, call]);
    return {
      ...base,
      commentIssue: (workspace, item, body, writeKey) =>
        record(`comment:${workspace.config.name}:${item}:${body}:${writeKey}`),
      addLabels: (workspace, item, labels) =>
        record(`add:${workspace.config.name}:${item}:${labels.join(",")}`),
      removeLabel: (workspace, item, label) => record(`remove:${workspace.config.name}:${item}:${label}`),
      closeIssue: (workspace, item) => record(`close:${workspace.config.name}:${item}`),
    };
  }),
);

const coordinationLayer = Layer.mock(Coordination, {
  fold,
  read: () =>
    Effect.succeed({
      ...fold({ claim: null, attempts: [], handbacks: [], parks: [], revision: null }, "cogwork"),
      barrierAtMillis: 0,
    }),
});

const adapterLayers = Layer.mergeAll(coordinationLayer, Layer.mock(SlackWrite, {}), trackerLayer).pipe(
  Layer.provideMerge(TrackerCalls.layer),
);

const requirements = Layer.mergeAll(
  engineTestLayer(),
  workflowActionPlanStoreLayer,
  workflowArtifactStoreLayer,
  Layer.effect(TriggerObservationStore, makeMemoryTriggerObservationStore),
  adapterLayers,
);

describe("Issue Action entries", () => {
  it.effect.each(["github", "linear"] as const)(
    "freezes the current %s issue and writes through the issue tracker port",
    (system) =>
      Effect.gen(function* () {
        const config = workspaces[system];
        const workspace: RegisteredWorkspace = {
          source: "control-store:workspace",
          contributions: [],
          config,
        };
        const admission = admissionFor(config);
        const writes = writesFor(system);

        const built = yield* buildWorkflowActionPlan({
          admission,
          document: WorkflowDocument.make({
            name: "Issue writes",
            workspaces: { _tag: "Every" },
            triggers: [],
            operations: [writes],
          }),
          operation: writes,
          catalog: {
            entries: issueTrackerWorkflowCatalogContribution(system).entries,
            instructionPackages: [],
            harnesses: [],
          },
          workspaces: [workspace],
          output: { summary: "Write", answers: {}, inputs: { comment: "Done" } },
          attempt,
          createdAtMillis: 10,
          workflowRevision: 1,
        });
        yield* (yield* WorkflowActionPlanStore).create(built);
        const result = yield* executeWorkflowActionPlan(built, admission);

        assert.deepStrictEqual(
          built.steps.map(({ target }) => target),
          Array(4).fill({
            _tag: "CurrentIssue",
            workspace: config.name,
            app: system,
            issueTracker: config.issueTracker,
            repository: null,
            issue,
          }),
        );
        assert.strictEqual(result._tag, "Complete");
        assert.deepStrictEqual(yield* Ref.get(yield* TrackerCalls), [
          `comment:${config.name}:${issue}:Done:${built.steps[0]?.writeKey}`,
          `add:${config.name}:${issue}:ready-for-agent`,
          `remove:${config.name}:${issue}:needs-triage`,
          `close:${config.name}:${issue}`,
        ]);
      }).pipe(Effect.provide(requirements), Effect.scoped),
  );
});
