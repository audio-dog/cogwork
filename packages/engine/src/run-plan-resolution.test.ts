import {
  type HandbackRecord,
  HarnessName,
  NeedIdentity,
  RunId,
  RunPlan,
  WorkflowCatalog,
  WorkflowId,
  WorkflowOperation,
  WorkItemId,
  WorkspaceId,
} from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  HarnessPreflight,
  type RunPlanFacts,
  RunPlanRejection,
  RunPlanResolution,
  resolveRunPlan,
} from "./run-plan-resolution";
import { TriggerAdmission } from "./trigger-observation-admission";

const encodePlan = Schema.encodeSync(RunPlan);
const workspace = Schema.decodeSync(WorkspaceId);

const operation = Schema.decodeSync(WorkflowOperation)({
  id: "implement",
  name: "Implement",
  instructionPackage: "implement-agent",
  instruction: "Build it.",
  permissionProfile: "full",
  requires: [],
  model: { harness: "claude-code", model: "opus", options: [{ id: "effort", value: "high" }] },
  forEach: null,
  questions: [],
  transitions: [
    {
      when: [],
      actions: [
        { entry: "github.open-pull-request", parameters: [] },
        { entry: "github.create-issue", parameters: [] },
        { entry: "github.comment-on-named-pull-request", parameters: [] },
      ],
      handOff: null,
    },
  ],
  hints: [],
});

const catalog = Schema.decodeSync(WorkflowCatalog)({
  entries: [
    {
      key: "github.open-pull-request",
      name: "Open a pull request",
      kind: "action",
      system: "github",
      connection: null,
      requires: [],
      parameters: [],
      itemKind: null,
      actsOn: ["*"],
      requiresWorkspace: true,
      workspaceSource: "item-else-agent",
      permissionProfile: "full",
      agentInputs: ["pr_title"],
      emits: [],
    },
    {
      key: "github.create-issue",
      name: "Create an issue",
      kind: "action",
      system: "github",
      connection: null,
      requires: [],
      parameters: [],
      itemKind: null,
      actsOn: ["*"],
      requiresWorkspace: true,
      workspaceSource: "item-else-agent",
      permissionProfile: "full",
      agentInputs: [],
      emits: [],
    },
    {
      key: "github.comment-on-named-pull-request",
      name: "Comment on a named pull request",
      kind: "action",
      system: "github",
      connection: null,
      requires: [],
      parameters: [],
      itemKind: null,
      actsOn: ["*"],
      requiresWorkspace: true,
      workspaceSource: "item-else-agent",
      permissionProfile: "full",
      agentInputs: [],
      emits: [],
    },
  ],
  instructionPackages: [],
  harnesses: [],
});

const lineage = { root: "issue:cogwork:%2342", parent: null, hop: 0 };

const issueAdmission = Schema.decodeSync(TriggerAdmission)({
  event: {
    key: { _tag: "Issue", workspace: "cogwork", id: "#42" },
    revision: "r1",
    cause: { _tag: "Unknown" },
    atMillis: 5_000,
    entry: "github.issue-labeled",
    workspace: "cogwork",
    priority: "high",
    subject: { title: "Extract Run Plan resolution", url: "https://example.test/issues/42" },
    workContext: {
      body: "Make it a pure module.",
      comments: [
        { author: "Taylor", authorAssociation: "OWNER", body: "Keep it small.", createdAtMillis: 4_000 },
      ],
    },
  },
  subscription: {
    workflow: "coding",
    trigger: "labeled",
    operation: "implement",
    entry: "github.issue-labeled",
    parameters: [],
    workspaces: [],
    catchUp: null,
  },
  lineage,
});

const harnessName = Schema.decodeSync(HarnessName)("claude-code");
const passedHarness = {
  name: harnessName,
  projectedMembers: ["Tools", "Skills"],
  middleware: ["sandbox", "persistence"],
  sessionKind: "opaque-handle",
} as const;

const issueFacts: RunPlanFacts = {
  id: Schema.decodeSync(RunId)("run-1"),
  admission: issueAdmission,
  workflow: { id: Schema.decodeSync(WorkflowId)("coding"), publishedRevision: 7 },
  operation,
  catalog,
  outputWorkspaces: [workspace("cogwork"), workspace("other")],
  harness: HarnessPreflight.Passed(passedHarness),
  workspaceCheckout: "/worktrees/42",
  worktreeSetup: [],
  instructions: {
    layers: [{ kind: "rules", source: "rules/house.md", content: "House rules." }],
    operatingInstructionsName: "implement-agent",
    operatingInstructionsPath: "/instructions/implement-agent",
    operatingInstructionResources: [{ source: "TEST-VALUE.md", content: "The bar." }],
    sources: [],
  },
  previousResultIssues: "The summary was empty.",
  resendRequest: null,
  lineageArtifacts: [],
  claim: {
    by: "cogwork",
    claimedAtMillis: 6_000,
    operation: { workflow: "coding", operation: "implement" },
    lineage: issueAdmission.lineage,
  },
  handback: null,
  gitOperationInProgress: null,
  skills: [{ identity: "skill:tdd", name: "tdd", source: "/skills/tdd/SKILL.md" }],
  subagents: [
    {
      _tag: "Unavailable",
      identity: "agent:reviewer",
      name: "reviewer",
      source: "/agents/reviewer.md",
      reason: "the file could not be read",
    },
  ],
};

const resolvedPlan = (facts: RunPlanFacts) =>
  RunPlanResolution.$match(resolveRunPlan(facts), {
    Accepted: ({ plan }) => plan,
    Rejected: ({ reason }) => assert.fail(`Run Plan rejected: ${reason._tag}`),
  });

const requestOnly = "Run Workflow Operation: Implement";

const issueWorkContext: (typeof RunPlan.Encoded)["workContext"] = {
  reference: { workItem: "issue:cogwork:%2342", url: "https://example.test/issues/42" },
  facts: {
    assignees: [],
    openBlockers: 0,
    claim: {
      by: "cogwork",
      claimedAtMillis: 6_000,
      operation: { workflow: "coding", operation: "implement" },
      lineage,
    },
    priority: "high",
  },
  prose: {
    body: "Make it a pure module.",
    comments: [
      { author: "Taylor", authorAssociation: "OWNER", body: "Keep it small.", createdAtMillis: 4_000 },
    ],
  },
  observation: { generation: 7, observedAtMillis: 5_000 },
};

describe("resolveRunPlan", () => {
  it("resolves an Issue item's Run Plan from its facts", () => {
    assert.deepStrictEqual(encodePlan(resolvedPlan(issueFacts)), {
      id: "run-1",
      operation: "implement",
      harness: { name: "claude-code", model: "opus", options: { effort: "high" }, profile: "full" },
      instructions: [{ kind: "rules", source: "rules/house.md", content: "House rules." }],
      operatingInstructions: {
        name: "implement-agent",
        path: "/instructions/implement-agent",
        resources: [
          { source: "TEST-VALUE.md", content: "The bar." },
          { source: "previous-result-issues", content: "The summary was empty." },
        ],
      },
      messages: [{ role: "user", content: requestOnly }],
      tools: ["issue-search", "pull-request"],
      skills: [{ identity: "skill:tdd", name: "tdd", source: "/skills/tdd/SKILL.md" }],
      mcp: [],
      subagents: [
        {
          _tag: "Unavailable",
          identity: "agent:reviewer",
          name: "reviewer",
          source: "/agents/reviewer.md",
          reason: "the file could not be read",
        },
      ],
      hooks: [],
      middleware: ["sandbox", "persistence"],
      structuredOutput: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          summary: { type: "string" },
          stuck: { type: "boolean" },
          answers: { type: "object", additionalProperties: false },
          inputs: {
            type: "object",
            properties: { pr_title: { type: "string" } },
            required: ["pr_title"],
            additionalProperties: false,
          },
        },
        required: ["summary", "stuck", "answers", "inputs"],
        additionalProperties: false,
      },
      connections: [],
      workContext: issueWorkContext,
      sandbox: { workspace: "/worktrees/42", policy: "full" },
      persistence: { sessionKind: "opaque-handle" },
      provenance: {
        resolution: [],
        stamps: [],
        projectedNames: [],
        projection: [
          { member: "Harness Adapter", disposition: "projected" },
          { member: "Instructions", disposition: "projected" },
          { member: "Messages", disposition: "projected" },
          { member: "Work Context", disposition: "projected" },
          { member: "Middleware", disposition: "projected" },
          { member: "Sandbox", disposition: "projected" },
          { member: "Structured Output", disposition: "projected" },
          { member: "Persistence", disposition: "projected" },
          { member: "Provenance", disposition: "projected" },
          { member: "Tools", disposition: "projected" },
          { member: "Skills", disposition: "projected" },
          {
            member: "Subagents",
            disposition: "not-projected",
            reason: "selected harness does not project Subagents",
          },
        ],
        observation: { generation: 7, observedAtMillis: 5_000 },
      },
    });
  });

  const handback: HandbackRecord = { by: "taylor", atMillis: 7_000, note: "  Use the smaller fix.  " };
  const granolaAdmission = Schema.decodeSync(TriggerAdmission)({
    ...Schema.encodeSync(TriggerAdmission)(issueAdmission),
    event: {
      key: { _tag: "GranolaNote", connection: "granola/person@example.com", noteId: "note-1" },
      revision: "r2",
      cause: { _tag: "Unknown" },
      atMillis: 5_000,
      entry: "granola.note-shared",
      workspace: null,
      payload: {
        _tag: "GranolaNote",
        title: "Weekly sync",
        attendees: ["Taylor", "Ari"],
        calendarEvent: "Weekly sync · 09:00",
        summary: "Ship the smaller change.",
        transcript: "Taylor: Ship it.\nAri: Agreed.",
      },
    },
  });
  const scheduleAdmission = Schema.decodeSync(TriggerAdmission)({
    ...Schema.encodeSync(TriggerAdmission)(issueAdmission),
    event: {
      key: { _tag: "ScheduleInstant", workflow: "coding", instantMillis: 1_000 },
      revision: "1000",
      cause: { _tag: "Clock" },
      atMillis: 1_000,
      entry: "schedule.daily",
      workspace: null,
    },
  });

  const engineFramedWorkContext = (workItem: string, body: string, observedAtMillis: number) => ({
    ...issueWorkContext,
    reference: { workItem, url: null },
    facts: { ...issueWorkContext.facts, priority: "medium" as const },
    prose: { body, comments: [] },
    observation: { generation: 7, observedAtMillis },
  });

  it.each([
    {
      name: "a Granola note",
      facts: { ...issueFacts, admission: granolaAdmission },
      workContext: engineFramedWorkContext(
        "granola-note:granola%2Fperson%40example.com:note-1",
        [
          "# Weekly sync",
          "",
          "## Attendees",
          "Taylor\nAri",
          "",
          "## Calendar event",
          "Weekly sync · 09:00",
          "",
          "## Summary",
          "Ship the smaller change.",
          "",
          "## Transcript",
          "Taylor: Ship it.\nAri: Agreed.",
        ].join("\n"),
        5_000,
      ),
      message: requestOnly,
    },
    {
      name: "a schedule instant",
      facts: { ...issueFacts, admission: scheduleAdmission },
      workContext: engineFramedWorkContext(
        "schedule:coding:1000",
        "Scheduled instant 1000 for Workflow coding.",
        1_000,
      ),
      message: requestOnly,
    },
    {
      name: "a handback with a note",
      facts: { ...issueFacts, handback },
      workContext: issueWorkContext,
      message: "Run Workflow Operation: Implement\n\nPerson's note: Use the smaller fix.",
    },
    {
      name: "a lineage with artifacts",
      facts: {
        ...issueFacts,
        lineageArtifacts: [
          {
            workspace: workspace("cogwork"),
            issue: Schema.decodeSync(WorkItemId)("#99"),
            url: "https://example.test/issues/99",
          },
        ],
      },
      workContext: {
        ...issueWorkContext,
        prose: {
          ...issueWorkContext.prose,
          body: [
            "Make it a pure module.",
            "",
            "## Artifacts this lineage created",
            '[{"workspace":"cogwork","issue":"#99","url":"https://example.test/issues/99"}]',
          ].join("\n"),
        },
      },
      message: requestOnly,
    },
  ])("frames the Work Context and message for $name", ({ facts, workContext, message }) => {
    const plan = encodePlan(resolvedPlan(facts));
    assert.deepStrictEqual(
      { workContext: plan.workContext, messages: plan.messages },
      {
        workContext,
        messages: [{ role: "user", content: message }],
      },
    );
  });

  it("asks the agent to choose a Workspace when the item names none", () => {
    const workspaceQuestion = Schema.decodeUnknownSync(
      Schema.Struct({
        required: Schema.Array(Schema.String),
        properties: Schema.Struct({ workspace: Schema.Unknown }),
      }),
    );
    assert.deepStrictEqual(
      workspaceQuestion(resolvedPlan({ ...issueFacts, admission: scheduleAdmission }).structuredOutput),
      {
        required: ["summary", "stuck", "answers", "inputs", "workspace"],
        properties: { workspace: { type: "string", enum: ["none", "cogwork", "other"] } },
      },
    );
  });

  it("lists no Tools and records every member unprojected when the Harness projects none", () => {
    const plan = encodePlan(
      resolvedPlan({
        ...issueFacts,
        harness: HarnessPreflight.Passed({ ...passedHarness, projectedMembers: [] }),
      }),
    );
    assert.deepStrictEqual(
      {
        tools: plan.tools,
        unprojected: plan.provenance.projection.filter(({ disposition }) => disposition === "not-projected"),
      },
      {
        tools: [],
        unprojected: [
          {
            member: "Tools",
            disposition: "not-projected" as const,
            reason: "selected harness does not project Tools",
          },
          {
            member: "Skills",
            disposition: "not-projected" as const,
            reason: "selected harness does not project Skills",
          },
          {
            member: "Subagents",
            disposition: "not-projected" as const,
            reason: "selected harness does not project Subagents",
          },
        ],
      },
    );
  });

  it.each([
    {
      name: "a writable Run in a Workspace with worktree setup",
      profile: "full" as const,
      worktreeSetup: ["pnpm install"],
      tools: ["issue-search", "pull-request", "worktree-setup"],
    },
    {
      name: "a read-only Run",
      profile: "read-only" as const,
      worktreeSetup: ["pnpm install"],
      tools: ["issue-search", "pull-request"],
    },
    {
      name: "a Workspace with no worktree setup",
      profile: "full" as const,
      worktreeSetup: [],
      tools: ["issue-search", "pull-request"],
    },
  ])("lists $tools for $name", ({ profile, worktreeSetup, tools }) => {
    const plan = resolvedPlan({
      ...issueFacts,
      operation: { ...operation, permissionProfile: profile },
      worktreeSetup,
    });
    assert.deepStrictEqual(plan.tools, tools);
  });

  const githubNeed = Schema.decodeSync(NeedIdentity)("connection:github");

  it.each([
    {
      name: "no Harness is selected",
      facts: { ...issueFacts, harness: HarnessPreflight.Unselected() },
      reason: RunPlanRejection.NoHarness(),
    },
    {
      name: "a required need is not ready",
      facts: { ...issueFacts, harness: HarnessPreflight.NeedMissing({ need: githubNeed }) },
      reason: RunPlanRejection.MissingNeed({ need: githubNeed }),
    },
    {
      name: "Harness preflight fails",
      facts: {
        ...issueFacts,
        harness: HarnessPreflight.Failed({ name: harnessName, message: "Harness signed out" }),
      },
      reason: RunPlanRejection.PreflightFailed({ harness: harnessName, message: "Harness signed out" }),
    },
  ])("rejects the Run Plan when $name", ({ facts, reason }) => {
    assert.deepStrictEqual(resolveRunPlan(facts), RunPlanResolution.Rejected({ reason }));
  });
});
