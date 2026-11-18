import { BranchName, keyOf, WorkflowDocument, WorkspaceConfig } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HarnessError } from "./harness";
import type { RegisteredWorkspace } from "./projector";
import { emptyRegistry } from "./registry";
import { RunLedger } from "./run-ledger";
import { emptyService as emptySourceControl, SourceControlProvider } from "./source-control";
import type { TriggerAdmission } from "./trigger-observation";
import type { WorkflowsService } from "./workflow";
import { WorkflowActionPlanStore } from "./workflow-action-plan-store";
import { admission } from "./workflow-run-admissions-fixtures";
import {
  decodeEntry,
  decodeWorkItem,
  document,
  harnessName,
  operation,
  siblingWorkflow,
  workflow,
  workflowRecord,
  workflowService,
} from "./workflow-run-documents-fixtures";
import {
  type HarnessBehavior,
  previousResultIssues,
  requirements,
  testProgram,
} from "./workflow-run-fixtures";
import { PullRequestReadiness, WorktreeManager } from "./worktree";

describe("WorkflowRun", () => {
  it.effect("refuses a matched action input that is empty after trim", () =>
    Effect.gen(function* () {
      const { runner, coordination } = yield* testProgram([
        {
          summary: "No message",
          stuck: false,
          answers: { done: "yes" },
          inputs: { notification: "   " },
        },
      ]);
      yield* runner.execute(admission);
      const [run] = yield* (yield* RunLedger).listRuns(10);
      const attempts = yield* Ref.get(coordination.attempts);

      assert.strictEqual(run?.status, "failed");
      assert.include(attempts[0]?.reason ?? "", "needs non-empty input notification");
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );

  it.effect("declines an empty pull request before recording its action plan", () => {
    const workspace = {
      source: "control-store:workspace",
      repository: "owner/repo",
      contributions: [],
      config: Schema.decodeSync(WorkspaceConfig)({
        name: "github",
        checkoutPath: "/repos/github",
        issueTracker: { type: "github" },
      }),
    } satisfies RegisteredWorkspace;
    const issue = decodeWorkItem("#820");
    const issueEntry = decodeEntry("github.issue-label");
    const openEntry = decodeEntry("github.open-pull-request");
    const reason = "head 820 is not ahead of origin/main";
    const issueAdmission = {
      ...admission,
      event: {
        ...admission.event,
        key: { _tag: "Issue", workspace: workspace.config.name, id: issue },
        entry: issueEntry,
        workspace: workspace.config.name,
      },
      subscription: {
        ...admission.subscription,
        entry: issueEntry,
        workspaces: [workspace.config.name],
      },
    } satisfies TriggerAdmission;
    const pullRequestDocument = Schema.decodeSync(WorkflowDocument)({
      ...document,
      workspaces: { _tag: "Listed", workspaces: [workspace.config.name] },
      triggers: [{ ...document.triggers[0], entry: issueEntry, parameters: [] }],
      operations: [
        {
          ...document.operations[0],
          permissionProfile: "full",
          questions: [],
          transitions: [
            {
              when: [],
              actions: [{ entry: openEntry, parameters: [] }],
              handOff: null,
            },
          ],
        },
      ],
    });
    const sourceService = {
      ...emptySourceControl,
      resolvePullRequest: () => Effect.succeed(null),
      openWorkflowPullRequest: () => Effect.die("must not open"),
    };
    const worktreeService = {
      ensure: () => Effect.succeed({ branch: BranchName.make("820"), path: "/worktrees/820", created: true }),
      pullRequestReadiness: () => Effect.succeed(PullRequestReadiness.Declined({ reason })),
    };
    const service = {
      ...workflowService,
      list: Effect.succeed({
        workflows: [{ ...workflowRecord, publishedCopy: pullRequestDocument }],
        unreadable: [],
      }),
      get: () => Effect.succeed({ ...workflowRecord, publishedCopy: pullRequestDocument }),
      catalog: Effect.succeed({
        catalog: {
          entries: [
            {
              key: issueEntry,
              name: "Issue has label",
              kind: "trigger",
              system: "github",
              connection: "github",
              requires: [],
              parameters: [],
              itemKind: "issue",
              actsOn: [],
              requiresWorkspace: true,
              workspaceSource: null,
              permissionProfile: "read-only",
              agentInputs: [],
              emits: [],
            },
            {
              key: openEntry,
              name: "Open a pull request",
              kind: "action",
              system: "github",
              connection: "github",
              requires: [],
              parameters: [],
              itemKind: null,
              actsOn: ["issue"],
              requiresWorkspace: true,
              workspaceSource: "item-else-agent",
              permissionProfile: "full",
              agentInputs: ["pr_title", "pr_body"],
              emits: [],
            },
          ],
          instructionPackages: [],
          harnesses: [],
        },
        machine: {
          workspaces: [
            {
              id: workspace.config.name,
              binds: ["github"],
            },
          ],
          connections: [],
          harnesses: [{ name: harnessName, available: true }],
          defaultHarness: harnessName,
          readyNeeds: [],
        },
      }),
    } satisfies WorkflowsService;

    const testLayer = Layer.mergeAll(
      requirements,
      Layer.succeed(SourceControlProvider, sourceService),
      Layer.mock(WorktreeManager, worktreeService),
    );

    const result = {
      summary: "Open it",
      stuck: false,
      answers: {},
      inputs: { pr_title: "Open output actions", pr_body: "Closes #820" },
    };
    const personText = `The engine did not open the pull request: ${reason}.`;
    const agentText = `The engine did not open a pull request from your previous result: ${reason}. Correct the branch before you return the result.`;

    return Effect.gen(function* () {
      const { runner, coordination } = yield* testProgram(
        [result, result, result],
        { registry: { ...emptyRegistry, workspaces: [workspace] } },
        service,
      );

      assert.strictEqual(yield* runner.execute(issueAdmission), "retry");
      assert.strictEqual(yield* runner.execute(issueAdmission), "retry");
      assert.strictEqual(yield* runner.execute(issueAdmission), "completed");
      const ledger = yield* RunLedger;
      const runs = yield* ledger.listRuns(10);
      const attempts = yield* Ref.get(coordination.attempts);
      assert.deepStrictEqual(
        {
          statuses: runs.map(({ status }) => status).toSorted(),
          reasons: attempts.map(({ reason }) => reason),
          park: (yield* Ref.get(coordination.parks)).at(-1)?.reason,
          nextRunIssues: yield* previousResultIssues(),
        },
        {
          statuses: ["declined", "declined", "exhausted"],
          reasons: [personText, personText, personText],
          park: { _tag: "Exhausted", reason: personText },
          nextRunIssues: [agentText, agentText],
        },
      );
      assert.isNull(
        yield* (yield* WorkflowActionPlanStore).pending(keyOf(issueAdmission.event.key), workflow),
      );
    }).pipe(Effect.provide(testLayer), Effect.scoped);
  });

  const refusedResults = [
    {
      name: "a result that does not match the schema",
      results: Array.from({ length: 3 }, () => ({
        summary: "Done",
        stuck: false,
        answers: { done: "maybe" },
        "x\n- y": 1,
      })),
      behavior: {},
      agentText: [
        "Your previous result did not match the result schema. Correct each issue below, then return the complete result again.",
        '- ["x\\n- y"]: Expected no excess property',
        '- answers.done: Expected "yes"',
        "- inputs: Missing key",
      ].join("\n"),
      personText:
        'The agent\'s result did not match the Operation\'s result schema (["x\\n- y"]: Expected no excess property; answers.done: Expected "yes"; inputs: Missing key).',
    },
    {
      name: "a result the action plan refuses",
      results: Array.from({ length: 3 }, () => ({
        summary: "No message",
        stuck: false,
        answers: { done: "yes" },
        inputs: { notification: "   " },
      })),
      behavior: {},
      agentText:
        "The engine could not build an action plan from your previous result: Action cogwork.notify needs non-empty input notification. Change the result so that the engine can act on it.",
      personText:
        "The engine could not act on the agent's result: Action cogwork.notify needs non-empty input notification.",
    },
    {
      name: "a Harness stream that fails",
      results: [],
      behavior: {
        run: () =>
          Stream.fail(
            new HarnessError({ reason: "turn", retryable: true, message: "The model connection closed" }),
          ),
      },
      agentText:
        "Your previous Run stopped before it returned a result. Return the result before the Run ends.",
      personText: "The Harness stopped before the agent returned a result: The model connection closed.",
    },
  ] satisfies ReadonlyArray<{
    readonly name: string;
    readonly results: ReadonlyArray<unknown>;
    readonly behavior: HarnessBehavior;
    readonly agentText: string;
    readonly personText: string;
  }>;

  refusedResults.map(({ name, results, behavior, agentText, personText }) =>
    it.effect(`parks the item after three refusals of ${name}`, () =>
      Effect.gen(function* () {
        const { runner, coordination } = yield* testProgram(results, behavior);
        const outcomes = [
          yield* runner.execute(admission),
          yield* runner.execute(admission),
          yield* runner.execute(admission),
        ];

        assert.deepStrictEqual(
          {
            outcomes,
            attempts: (yield* Ref.get(coordination.attempts)).map(({ reason }) => reason),
            park: (yield* Ref.get(coordination.parks)).at(-1)?.reason,
            processed: yield* Ref.get(coordination.processed),
            nextRunIssues: yield* previousResultIssues(),
          },
          {
            outcomes: ["retry", "retry", "completed"],
            attempts: [personText, personText, personText],
            park: { _tag: "Exhausted", reason: personText },
            processed: null,
            nextRunIssues: [agentText, agentText],
          },
        );
      }).pipe(Effect.provide(requirements), Effect.scoped),
    ),
  );

  it.effect("parks a stuck result without blocking a sibling Workflow", () =>
    Effect.gen(function* () {
      const siblingAdmission = {
        ...admission,
        subscription: { ...admission.subscription, workflow: siblingWorkflow },
      } satisfies TriggerAdmission;
      const { runner, coordination, observationStore } = yield* testProgram([
        {
          summary: "Needs a decision",
          stuck: true,
          answers: { done: "yes" },
          inputs: { notification: "Needs a decision" },
        },
      ]);
      yield* observationStore.putAll([admission, siblingAdmission]);
      yield* runner.execute(admission);

      assert.lengthOf(yield* Ref.get(coordination.attempts), 1);
      assert.strictEqual((yield* Ref.get(coordination.parks)).at(-1)?.reason._tag, "Stuck");
      assert.isNull(yield* Ref.get(coordination.processed));
      assert.strictEqual(
        (yield* coordination.service.read(admission.event.key)).gate({ workflow: siblingWorkflow, operation })
          ._tag,
        "Open",
      );
    }).pipe(Effect.provide(requirements), Effect.scoped),
  );
});
