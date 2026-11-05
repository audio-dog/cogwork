import {
  HarnessName,
  LineageId,
  type MachineReadiness,
  NeedIdentity,
  RunId,
  RunPlan,
  WorkflowActionArtifact,
  type WorkflowCatalogEntry,
  WorkflowCatalogKey,
  WorkflowDocument,
  WorkflowId,
  WorkflowNodeId,
  WorkItemId,
  WorkItemKey,
  WorkspaceId,
} from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { type RunPlanFacts, resolveRunPlan, selectRunHarness } from "./run-plan-resolution";

const node = Schema.decodeSync(WorkflowNodeId);
const encodePlan = Schema.encodeSync(RunPlan);
const entry = Schema.decodeSync(WorkflowCatalogKey);
const workspace = Schema.decodeSync(WorkspaceId)("cogwork");
const issue = Schema.decodeSync(WorkItemId)("#905");
const workflow = Schema.decodeSync(WorkflowId)("implement");
const harness = Schema.decodeSync(HarnessName)("claude-code");
const ownHarness = Schema.decodeSync(HarnessName)("codex");
const lineage = { root: LineageId.make("issue:cogwork:%23905"), parent: null, hop: 0 };
const commentEntry = entry("github.comment-issue");
const reviewEntry = entry("github.post-review");
const notifyEntry = entry("cogwork.notify");

const actionEntry = (key: WorkflowCatalogKey): WorkflowCatalogEntry => ({
  key,
  name: key,
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
});

const operationWith = (actions: ReadonlyArray<WorkflowCatalogKey>) => {
  const [operation] = Schema.decodeSync(WorkflowDocument)({
    name: "Implement",
    workspaces: { _tag: "Listed", workspaces: [] },
    triggers: [
      { id: node("labelled"), entry: entry("schedule.daily"), parameters: [], start: node("implement") },
    ],
    operations: [
      {
        id: node("implement"),
        name: "Implement",
        instructionPackage: "implement-agent",
        instruction: "Implement the item.",
        permissionProfile: "full",
        requires: [],
        model: { harness: null, model: "opus", options: [{ id: "effort", value: "high" }] },
        forEach: null,
        questions: [{ id: node("done"), text: "Done?", choices: [{ id: node("yes"), name: "Yes" }] }],
        transitions: [
          {
            when: [{ question: node("done"), choice: node("yes") }],
            actions: actions.map((key) => ({ entry: key, parameters: [] })),
            handOff: null,
          },
        ],
        hints: [],
      },
    ],
  }).operations;
  if (operation === undefined) throw new Error("Missing test Operation");
  return operation;
};

const claim = {
  by: "cogwork",
  claimedAtMillis: 2_000,
  operation: { workflow, operation: node("implement") },
  lineage,
};

const facts: RunPlanFacts = {
  id: RunId.make("run-1"),
  admission: {
    event: {
      key: { _tag: "Issue", workspace, id: issue },
      revision: "7",
      cause: { _tag: "Unknown" },
      atMillis: 1_000,
      entry: entry("github.issue-labelled"),
      workspace,
      subject: { title: "Extract Run Plan resolution", url: "https://github.com/o/r/issues/905" },
      priority: "high",
      workContext: {
        body: "## What to build",
        comments: [{ author: "Taylor", authorAssociation: "OWNER", body: "Go.", createdAtMillis: 900 }],
      },
    },
    subscription: {
      workflow,
      trigger: node("labelled"),
      operation: node("implement"),
      entry: entry("github.issue-labelled"),
      parameters: [],
      filters: [],
      workspaces: [],
      catchUp: { since: 0 },
    },
    lineage,
  },
  workflow: { id: workflow, publishedRevision: 4 },
  operation: operationWith([notifyEntry]),
  catalog: {
    entries: [commentEntry, reviewEntry, notifyEntry].map(actionEntry),
    instructionPackages: [],
    harnesses: [],
  },
  harness: { name: harness, middleware: [], sessionKind: "opaque-handle" },
  outputWorkspaces: [workspace],
  workspaceCheckout: "/checkouts/905",
  instructions: {
    layers: [{ kind: "repo", source: "AGENTS.md", content: "Repo rules." }],
    operatingInstructionsName: "implement-agent",
    operatingInstructionsPath: "/instructions/implement-agent",
    operatingInstructionResources: [{ source: "TEST-VALUE.md", content: "Test value." }],
    sources: [],
  },
  priorIssues: null,
  claim,
  handback: null,
  lineageArtifacts: [],
};

const scheduleAdmission = {
  ...facts.admission,
  event: {
    ...facts.admission.event,
    key: { _tag: "ScheduleInstant", workflow, instantMillis: 1_000 },
    revision: "1500",
    workContext: undefined,
    subject: undefined,
    priority: undefined,
  },
} satisfies RunPlanFacts["admission"];

describe("resolveRunPlan", () => {
  it("resolves an Issue item into the Run Plan the Harness receives", () => {
    const plan = encodePlan(resolveRunPlan(facts));

    assert.deepStrictEqual(plan.harness, {
      name: harness,
      model: "opus",
      options: { effort: "high" },
      profile: "full",
    });
    assert.deepStrictEqual(plan.messages, [{ role: "user", content: "Run Workflow Operation: Implement" }]);
    assert.deepStrictEqual(plan.workContext, {
      reference: {
        workItem: "issue:cogwork:%23905",
        url: "https://github.com/o/r/issues/905",
      },
      facts: { assignees: [], openBlockers: 0, claim, priority: "high" },
      prose: {
        body: "## What to build",
        comments: [{ author: "Taylor", authorAssociation: "OWNER", body: "Go.", createdAtMillis: 900 }],
      },
      observation: { generation: 4, observedAtMillis: 1_000 },
    });
  });

  it.each<{ readonly name: string; readonly facts: RunPlanFacts; readonly body: string }>([
    {
      name: "a Granola note becomes the prose body",
      facts: {
        ...facts,
        admission: {
          ...scheduleAdmission,
          event: {
            ...scheduleAdmission.event,
            payload: {
              _tag: "GranolaNote",
              title: "Weekly sync",
              attendees: ["Taylor", "Ari"],
              calendarEvent: "Weekly sync · 09:00",
              summary: "Ship it.",
              transcript: "Taylor: Ship it.",
            },
          },
        },
      },
      body: [
        "# Weekly sync",
        "",
        "## Attendees",
        "Taylor\nAri",
        "",
        "## Calendar event",
        "Weekly sync · 09:00",
        "",
        "## Summary",
        "Ship it.",
        "",
        "## Transcript",
        "Taylor: Ship it.",
      ].join("\n"),
    },
    {
      name: "a schedule instant names its revision",
      facts: { ...facts, admission: scheduleAdmission },
      body: "Scheduled instant 1500 for Workflow implement.",
    },
    {
      name: "a lineage appends the artifacts it created",
      facts: {
        ...facts,
        lineageArtifacts: [
          WorkflowActionArtifact.make({
            kind: "IssueCreated",
            workspace,
            issue: Schema.decodeSync(WorkItemId)("#906"),
            url: "https://github.com/o/r/issues/906",
            origin: {
              item: WorkItemKey.make("issue:cogwork:%23905"),
              workflow,
              attempt: RunId.make("run-0"),
              writeKey: "write-1",
              lineage,
            },
          }),
        ],
      },
      body: [
        "## What to build",
        "",
        "## Artifacts this lineage created",
        '[{"workspace":"cogwork","issue":"#906","url":"https://github.com/o/r/issues/906"}]',
      ].join("\n"),
    },
  ])("$name", ({ facts: input, body }) => {
    assert.strictEqual(resolveRunPlan(input).workContext.prose.body, body);
  });

  it("carries a handback note and prior decode issues into the Run", () => {
    const plan = encodePlan(
      resolveRunPlan({
        ...facts,
        handback: { by: "taylor", atMillis: 1_500, note: "  Use the smaller fix.  " },
        priorIssues: "Missing summary",
      }),
    );

    assert.deepStrictEqual(plan.messages, [
      { role: "user", content: "Run Workflow Operation: Implement\n\nPerson's note: Use the smaller fix." },
    ]);
    assert.deepStrictEqual(plan.operatingInstructions.resources, [
      { source: "TEST-VALUE.md", content: "Test value." },
      { source: "previous-result-issues", content: "Missing summary" },
    ]);
  });

  it("grants the engine Tools the Operation's Action entries need", () => {
    const plan = resolveRunPlan({ ...facts, operation: operationWith([reviewEntry, commentEntry]) });

    assert.deepStrictEqual(plan.tools, ["issue-search", "pull-request"]);
  });
});

describe("selectRunHarness", () => {
  const machine = {
    workspaces: [],
    connections: [],
    harnesses: [],
    defaultHarness: harness,
    readyNeeds: [],
  };

  it.each<{
    readonly name: string;
    readonly operation: RunPlanFacts["operation"];
    readonly machine: MachineReadiness;
    readonly expected: HarnessName | null;
  }>([
    { name: "falls back to the machine default", operation: facts.operation, machine, expected: harness },
    {
      name: "prefers the Operation's own Harness",
      operation: { ...facts.operation, model: { ...facts.operation.model, harness: ownHarness } },
      machine,
      expected: ownHarness,
    },
    {
      name: "declines without a Harness",
      operation: facts.operation,
      machine: { ...machine, defaultHarness: null },
      expected: null,
    },
    {
      name: "declines a missing need",
      operation: { ...facts.operation, requires: [NeedIdentity.make("github")] },
      machine,
      expected: null,
    },
  ])("$name", ({ operation, machine: readiness, expected }) => {
    assert.strictEqual(selectRunHarness(operation, readiness), expected);
  });
});
