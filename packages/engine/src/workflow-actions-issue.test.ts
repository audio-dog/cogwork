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
import { actionEntryFor } from "./workflow-action-registry";
import { type IssueTrackerApp, issueTrackerApps } from "./workflow-actions-issue";
import { memoryLayer as workflowArtifactStoreLayer } from "./workflow-artifact-store";
import { cogworkWorkflowCatalogContribution } from "./workflow-catalog";

const decodeEntry = Schema.decodeSync(WorkflowCatalogKey);
const attempt = Schema.decodeSync(RunId)("issue-plan");
const operation = Schema.decodeSync(WorkflowNodeId)("write");
const item = Schema.decodeSync(WorkItemId)("#899");
const existingIssue = Schema.decodeSync(WorkItemId)("#7");
const issueActions = [
  "create-issue",
  "comment-issue",
  "comment-this-item",
  "add-label",
  "remove-label",
  "close-this-issue",
];

const issueTrackers = {
  github: { type: "github" },
  linear: { type: "linear", teams: ["CGW"] },
} as const;

const workspaceFor = (system: IssueTrackerApp): RegisteredWorkspace => ({
  source: "control-store:workspace",
  contributions: [],
  config: Schema.decodeSync(WorkspaceConfig)({
    name: `${system}-repo`,
    checkoutPath: `/${system}`,
    issueTracker: issueTrackers[system],
  }),
});

const admissionFor = (workspace: RegisteredWorkspace): TriggerAdmission => {
  const ref = { _tag: "Issue", workspace: workspace.config.name, id: item } as const;
  const entry = decodeEntry(`${workspace.config.issueTracker.type}.issue-changed`);
  return {
    event: {
      key: ref,
      revision: "1",
      cause: { _tag: "Unknown" },
      atMillis: 1,
      entry,
      workspace: workspace.config.name,
    },
    subscription: {
      workflow: Schema.decodeSync(WorkflowId)("issue-writes"),
      trigger: Schema.decodeSync(WorkflowNodeId)("issue-changed"),
      operation,
      entry,
      parameters: [],
      filters: [],
      workspaces: [workspace.config.name],
      catchUp: { since: 0 },
    },
    lineage: {
      root: Schema.decodeSync(Schema.String.pipe(Schema.brand("LineageId")))(keyOf(ref)),
      parent: null,
      hop: 0,
    },
  };
};

const writeOperation = (system: IssueTrackerApp) =>
  ({
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
          { entry: decodeEntry(`${system}.comment-this-item`), parameters: [] },
          { entry: decodeEntry(`${system}.add-label`), parameters: [{ id: "label", value: "ready" }] },
          { entry: decodeEntry(`${system}.remove-label`), parameters: [{ id: "label", value: "triage" }] },
          { entry: decodeEntry(`${system}.close-this-issue`), parameters: [] },
        ],
        handOff: null,
      },
    ],
    hints: [],
  }) as const;

const requirements = Layer.mergeAll(
  engineTestLayer(),
  workflowActionPlanStoreLayer,
  workflowArtifactStoreLayer,
  Layer.effect(TriggerObservationStore, makeMemoryTriggerObservationStore),
  Layer.mock(Coordination, {
    fold,
    read: () =>
      Effect.succeed({
        ...fold({ claim: null, attempts: [], handbacks: [], parks: [], revision: null }, "cogwork"),
        barrierAtMillis: 0,
      }),
  }),
  Layer.mock(SlackWrite, {}),
);

describe("Issue Action entries", () => {
  it("derive each tracker's catalog rows from the registry", () => {
    const cogworkKeys = cogworkWorkflowCatalogContribution.entries.map(({ key }) => key);
    for (const system of issueTrackerApps) {
      const rows = issueTrackerWorkflowCatalogContribution(system).entries;
      for (const action of issueActions) {
        const key = `${system}.${action}`;
        assert.strictEqual(
          rows.find((row) => row.key === key),
          actionEntryFor(key)?.row,
        );
        assert.notInclude(cogworkKeys, key);
      }
    }
  });

  for (const system of issueTrackerApps) {
    it.effect(`freezes ${system} new and existing issue targets from the selected Workspace`, () =>
      Effect.gen(function* () {
        const workspace = workspaceFor(system);
        const name = workspace.config.name;
        const targetOf = (action: string, selected: string, inputs: Record<string, string>) => {
          const entry = actionEntryFor(`${system}.${action}`);
          assert.isDefined(entry);
          return entry.target({
            entry: entry.row,
            admission: admissionFor(workspace),
            workspaces: [workspace],
            inputs,
            parameters: [],
            workspace: selected,
            sourceControl: undefined,
          });
        };
        const frozen = {
          workspace: name,
          app: workspace.config.issueTracker.type,
          issueTracker: workspace.config.issueTracker,
          repository: null,
        };

        assert.deepStrictEqual(yield* targetOf("create-issue", name, {}), { _tag: "NewIssue", ...frozen });
        assert.deepStrictEqual(yield* targetOf("create-issue", "none", {}), { _tag: "NoWorkspace" });
        assert.deepStrictEqual(
          yield* targetOf("comment-issue", name, { issue: `${name}:${existingIssue}` }),
          { _tag: "ExistingIssue", ...frozen, issue: existingIssue },
        );
      }),
    );

    it.effect(`freezes the current ${system} issue and writes through the issue tracker port`, () =>
      Effect.gen(function* () {
        const workspace = workspaceFor(system);
        const admission = admissionFor(workspace);
        const document = WorkflowDocument.make({
          name: "Issue writes",
          workspaces: { _tag: "Every" },
          triggers: [],
          operations: [writeOperation(system)],
        });
        const plan = yield* buildWorkflowActionPlan({
          admission,
          document,
          operation: writeOperation(system),
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
        const calls = yield* Ref.make<ReadonlyArray<string>>([]);
        const record = (call: string) => Ref.update(calls, (current) => [...current, call]);
        const tracker = {
          ...(yield* makeEmpty),
          commentIssue: (target, issue, body, writeKey) =>
            record(`comment ${target.config.name} ${issue} ${body} ${writeKey}`),
          addLabels: (target, issue, labels) =>
            record(`add ${target.config.name} ${issue} ${labels.join(",")}`),
          removeLabel: (target, issue, label) => record(`remove ${target.config.name} ${issue} ${label}`),
          closeIssue: (target, issue) => record(`close ${target.config.name} ${issue}`),
        } satisfies typeof IssueTracker.Service;
        yield* (yield* WorkflowActionPlanStore).create(plan);

        const result = yield* executeWorkflowActionPlan(plan, admission).pipe(
          Effect.provideService(IssueTracker, tracker),
        );

        assert.deepStrictEqual(
          plan.steps.map(({ target }) => target),
          plan.steps.map(() => ({
            _tag: "CurrentIssue" as const,
            workspace: workspace.config.name,
            app: workspace.config.issueTracker.type,
            issueTracker: workspace.config.issueTracker,
            repository: null,
            issue: item,
          })),
        );
        assert.strictEqual(result._tag, "Complete");
        const name = workspace.config.name;
        assert.deepStrictEqual(yield* Ref.get(calls), [
          `comment ${name} ${item} Done ${plan.steps[0]?.writeKey}`,
          `add ${name} ${item} ready`,
          `remove ${name} ${item} triage`,
          `close ${name} ${item}`,
        ]);
      }).pipe(Effect.provide(requirements)),
    );
  }
});
