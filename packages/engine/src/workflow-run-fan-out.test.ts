import {
  keyOf,
  LineageId,
  WorkflowActionArtifact,
  WorkflowDocument,
  WorkItemId,
  WorkspaceConfig,
} from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { type IssueTrackerService, makeEmpty as makeEmptyIssueTracker } from "./issue-tracker";
import type { RegisteredWorkspace } from "./projector";
import { RunLedger } from "./run-ledger";
import { TriggerObservationStoreError } from "./trigger-observation-store";
import type { WorkflowsService } from "./workflow";
import { admission, granolaAdmission } from "./workflow-run-admissions-fixtures";
import {
  decodeEntry,
  decodeNode,
  document,
  workflowService,
  workflowServiceWith,
} from "./workflow-run-documents-fixtures";
import { requirements, testProgram } from "./workflow-run-fixtures";

const exerciseFanOut = Effect.fn("WorkflowRunTest.exerciseFanOut")(function* (
  summaries: ReadonlyArray<string>,
) {
  const fanOutDocument = WorkflowDocument.make({
    ...document,
    operations: document.operations.map((candidate) => ({
      ...candidate,
      forEach: "commitment",
    })),
  });
  const { runner, notifications, observationStore } = yield* testProgram(
    [
      {
        summary: summaries.length === 0 ? "No commitments" : "Three commitments",
        stuck: false,
        elements: summaries.map((summary) => ({
          summary,
          answers: { done: "yes" },
          inputs: { notification: summary },
        })),
      },
    ],
    {},
    workflowServiceWith(fanOutDocument),
  );
  yield* observationStore.putAll([granolaAdmission]);

  assert.strictEqual(yield* runner.execute(granolaAdmission), "completed");
  const children = yield* observationStore.admissions;
  assert.lengthOf(children, summaries.length);
  const childRun = children[0]?.event.key._tag === "FanOutChild" ? children[0].event.key.run : null;
  assert.deepStrictEqual(
    children.map(({ event, lineage }) => ({
      tag: event.key._tag,
      parent: event.key._tag === "FanOutChild" ? event.key.parent : null,
      run: event.key._tag === "FanOutChild" ? event.key.run : null,
      position: event.key._tag === "FanOutChild" ? event.key.position : null,
      lineage,
    })),
    summaries.map((_, position) => ({
      tag: "FanOutChild" as const,
      parent: keyOf(granolaAdmission.event.key),
      run: childRun,
      position,
      lineage: {
        root: granolaAdmission.lineage.root,
        parent: childRun === null ? null : LineageId.make(childRun),
        hop: 1,
      },
    })),
  );
  yield* Effect.forEach(children, runner.execute, { discard: true });
  assert.deepStrictEqual(
    (yield* notifications.list).map(({ summary }) => summary),
    [...summaries],
  );
});

describe("WorkflowRun", () => {
  it.effect("fans each result element into one child item with inherited lineage", () =>
    Effect.forEach([[], ["First", "Second", "Third"]] as const, exerciseFanOut, {
      discard: true,
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("retries a failed fan-out without exposing duplicate children", () =>
    Effect.gen(function* () {
      const fanOutDocument = WorkflowDocument.make({
        ...document,
        operations: document.operations.map((candidate) => ({ ...candidate, forEach: "commitment" })),
      });
      const output = {
        summary: "Two commitments",
        stuck: false,
        elements: ["First", "Second"].map((summary) => ({
          summary,
          answers: { done: "yes" },
          inputs: { notification: summary },
        })),
      };
      const failFanOut = yield* Ref.make(true);
      const { runner, observationStore } = yield* testProgram(
        [output, output],
        {
          observationStore: (base) => ({
            ...base,
            fanOut: (parent, children, closeRevision) =>
              Ref.getAndSet(failFanOut, false).pipe(
                Effect.flatMap((fail) =>
                  fail
                    ? Effect.fail(new TriggerObservationStoreError({ message: "fan-out write failed" }))
                    : base.fanOut(parent, children, closeRevision),
                ),
              ),
          }),
        },
        workflowServiceWith(fanOutDocument),
      );
      yield* observationStore.putAll([granolaAdmission]);

      assert.isTrue(Result.isFailure(yield* Effect.result(runner.execute(granolaAdmission))));
      assert.deepStrictEqual(yield* observationStore.admissions, [granolaAdmission]);
      assert.strictEqual(yield* runner.execute(granolaAdmission), "completed");
      assert.lengthOf(yield* observationStore.admissions, 2);
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("parks a lineage at hop 25 before starting a Run", () =>
    Effect.gen(function* () {
      const capped = { ...admission, lineage: { ...admission.lineage, hop: 25 } };
      const { runner, coordination, observationStore } = yield* testProgram([]);
      yield* observationStore.putAll([capped]);

      assert.strictEqual(yield* runner.execute(capped), "completed");
      assert.strictEqual((yield* Ref.get(coordination.parks))[0]?.reason._tag, "HopCap");
      assert.isEmpty(yield* (yield* RunLedger).listRuns(1));
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("runs the Granola to issue document through child routes", () =>
    Effect.gen(function* () {
      const repo: RegisteredWorkspace = {
        source: "test",
        contributions: [],
        repository: "colonylabs/cogwork",
        config: yield* Schema.decodeEffect(WorkspaceConfig)({
          id: "cogwork",
          displayName: "cogwork",
          checkoutPath: "/cogwork",
          issueTracker: { type: "github" },
        }),
      };
      const createEntry = decodeEntry("github.create-issue");
      const commentEntry = decodeEntry("github.comment-issue");
      const match = decodeNode("match");
      const newChoice = decodeNode("new");
      const duplicateChoice = decodeNode("duplicate");
      const relatedChoice = decodeNode("related");
      const actionEntry = (key: typeof createEntry, name: string, inputs: ReadonlyArray<string>) => ({
        key,
        name,
        kind: "action" as const,
        system: "github",
        connection: "github",
        requires: [],
        parameters: [],
        itemKind: null,
        actsOn: ["*"],
        requiresWorkspace: true,
        workspaceSource: "agent" as const,
        permissionProfile: "read-only" as const,
        agentInputs: inputs,
        emits: [],
      });
      const granolaDocument = WorkflowDocument.make({
        ...document,
        workspaces: { _tag: "Listed", workspaces: [repo.config.id] },
        operations: [
          {
            ...document.operations[0],
            forEach: "commitment",
            questions: [
              {
                id: match,
                text: "Match?",
                choices: [
                  { id: newChoice, name: "New" },
                  { id: duplicateChoice, name: "Duplicate" },
                  { id: relatedChoice, name: "Related" },
                ],
              },
            ],
            transitions: [
              {
                when: [{ question: match, choice: newChoice }],
                actions: [{ entry: createEntry, parameters: [] }],
                handOff: null,
              },
              ...[duplicateChoice, relatedChoice].map((choice) => ({
                when: [{ question: match, choice }],
                actions: [{ entry: commentEntry, parameters: [] }],
                handOff: null,
              })),
            ],
          },
        ],
      });
      const baseCatalogResult = yield* workflowService.catalog;
      const granolaService = {
        ...workflowServiceWith(granolaDocument),
        catalog: Effect.succeed({
          ...baseCatalogResult,
          catalog: {
            ...baseCatalogResult.catalog,
            entries: [
              ...baseCatalogResult.catalog.entries,
              actionEntry(createEntry, "Create an issue", ["issue_title", "issue_body"]),
              actionEntry(commentEntry, "Comment on an issue", ["issue", "comment"]),
            ],
          },
        }),
      } satisfies WorkflowsService;
      const writes = yield* Ref.make<ReadonlyArray<string>>([]);
      const baseTracker = yield* makeEmptyIssueTracker;
      const tracker = {
        ...baseTracker,
        createIssue: (workspace: Parameters<IssueTrackerService["createIssue"]>[0], input) =>
          Ref.modify(writes, (current) => {
            const issue = WorkItemId.make(`#${current.length + 100}`);
            return [
              WorkflowActionArtifact.make({
                kind: "IssueCreated",
                workspace: workspace.config.id,
                issue,
                url: `https://example.test/issues/${issue.slice(1)}`,
                origin: input.origin,
              }),
              [...current, `create:${input.title}`],
            ];
          }),
        commentIssue: (_workspace, issue, body) =>
          Ref.update(writes, (current) => [...current, `comment:${issue}:${body}`]),
      } satisfies IssueTrackerService;
      const blankInputs = { issue_title: "", issue_body: "", issue: "", comment: "" };
      const { runner, observationStore } = yield* testProgram(
        [
          {
            summary: "Three commitments",
            stuck: false,
            elements: [
              {
                summary: "Add retries",
                answers: { match: "new" },
                inputs: { ...blankInputs, issue_title: "Add retries", issue_body: "Retry failed sends." },
                workspace: "cogwork",
              },
              {
                summary: "Document setup",
                answers: { match: "duplicate" },
                inputs: { ...blankInputs, issue: "#12", comment: "Captured in the meeting." },
                workspace: "cogwork",
              },
              {
                summary: "Expose health",
                answers: { match: "new" },
                inputs: { ...blankInputs, issue_title: "Expose health", issue_body: "Show source health." },
                workspace: "cogwork",
              },
            ],
          },
        ],
        { issueTracker: tracker, registry: { workspaces: [repo], failures: [] } },
        granolaService,
      );
      yield* observationStore.putAll([granolaAdmission]);

      yield* runner.execute(granolaAdmission);
      yield* Effect.forEach(yield* observationStore.admissions, runner.execute, { discard: true });

      assert.deepStrictEqual(yield* Ref.get(writes), [
        "create:Add retries",
        "comment:#12:Captured in the meeting.",
        "create:Expose health",
      ]);
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );
});
