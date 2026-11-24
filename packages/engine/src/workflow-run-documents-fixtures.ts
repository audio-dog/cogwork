import {
  HarnessName,
  localOwnerId,
  RunId,
  SessionId,
  SourceControlType,
  type WorkflowCatalogEntry,
  WorkflowCatalogKey,
  WorkflowDocument,
  WorkflowId,
  WorkflowNodeId,
  type WorkflowRecord,
  WorkItemId,
  WorkspaceConfig,
  WorkspaceId,
} from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { clockEntries } from "./clock-source";
import type { RegisteredWorkspace } from "./projector";
import type { WorkflowsService } from "./workflow";

const decodeWorkflow = Schema.decodeSync(WorkflowId);
export const decodeNode = Schema.decodeSync(WorkflowNodeId);
export const decodeEntry = Schema.decodeSync(WorkflowCatalogKey);
export const decodeRun = Schema.decodeSync(RunId);
export const decodeSession = Schema.decodeSync(SessionId);
export const decodeWorkItem = Schema.decodeSync(WorkItemId);
export const decodeWorkspace = Schema.decodeSync(WorkspaceId);
export const githubSourceControlType = Schema.decodeSync(SourceControlType)("github");
export const workflow = decodeWorkflow("daily-summary");
export const siblingWorkflow = decodeWorkflow("sibling-summary");
export const trigger = decodeNode("schedule");
export const siblingTrigger = decodeNode("schedule-sibling");
export const operation = decodeNode("summarize");
export const harnessName = Schema.decodeSync(HarnessName)("scripted");
export const notifyEntry = decodeEntry("cogwork.notify");
export const waitForApprovalEntry = decodeEntry("cogwork.wait-for-approval");
export const handToMeEntry = decodeEntry("cogwork.hand-to-me");
export const scheduleEntry = decodeEntry("schedule.daily");
export const decodeDecisionValue = Schema.decodeUnknownSync(
  Schema.Struct({
    object: Schema.Record(Schema.String, Schema.Unknown),
    raw: Schema.String,
  }),
);

export const document = Schema.decodeSync(WorkflowDocument)({
  name: "Daily summary",
  workspaces: { _tag: "Listed", workspaces: [] },
  triggers: [trigger, siblingTrigger].map((id) => ({
    id,
    entry: scheduleEntry,
    parameters: [],
    start: operation,
  })),
  operations: [
    {
      id: operation,
      name: "Summarize",
      instructionPackage: "implement-agent",
      instruction: "Summarize the day.",
      permissionProfile: "read-only",
      commands: { allow: [], deny: [] },
      connections: [],
      requires: [],
      model: { harness: harnessName, model: null, options: [] },
      forEach: null,
      questions: [
        { id: decodeNode("done"), text: "Done?", choices: [{ id: decodeNode("yes"), name: "Yes" }] },
      ],
      transitions: [
        {
          when: [{ question: decodeNode("done"), choice: decodeNode("yes") }],
          actions: [{ entry: notifyEntry, parameters: [] }],
          handOff: null,
        },
      ],
      hints: [],
    },
  ],
});

export const workflowRecord: WorkflowRecord = {
  id: workflow,
  principal: localOwnerId,
  workingCopy: document,
  workingRevision: 1,
  publishedCopy: document,
  publishedRevision: 1,
  enabled: true,
  diagnostics: [],
  readiness: [],
};

export const workflowService: WorkflowsService = {
  create: () => Effect.die("unused"),
  edit: () => Effect.die("unused"),
  publish: () => Effect.die("unused"),
  switch: () => Effect.die("unused"),
  delete: () => Effect.die("unused"),
  list: Effect.succeed({ workflows: [workflowRecord], unreadable: [] }),
  get: () => Effect.succeed(workflowRecord),
  validate: () => Effect.succeed([]),
  catalog: Effect.succeed({
    catalog: {
      entries: [
        ...clockEntries,
        {
          key: notifyEntry,
          name: "Notify me",
          kind: "action",
          system: null,
          connection: null,
          requires: [],
          parameters: [],
          itemKind: null,
          actsOn: ["*"],
          requiresWorkspace: false,
          workspaceSource: null,
          permissionProfile: "read-only",
          agentInputs: ["notification"],
          emits: [],
        },
        {
          key: handToMeEntry,
          name: "Hand to me",
          kind: "action",
          system: null,
          connection: null,
          requires: [],
          parameters: [],
          itemKind: null,
          actsOn: ["*"],
          requiresWorkspace: false,
          workspaceSource: null,
          permissionProfile: "read-only",
          agentInputs: ["hand_off"],
          emits: [],
        },
      ],
      instructionPackages: [],
      harnesses: [],
    },
    machine: {
      workspaces: [],
      connections: [],
      harnesses: [{ name: harnessName, available: true }],
      defaultHarness: harnessName,
      readyNeeds: [],
    },
  }),
  templates: Effect.succeed([]),
  listOptions: () => Effect.succeed([]),
};

export const waitForApprovalCatalogEntry = {
  key: waitForApprovalEntry,
  name: "Wait for my approval",
  kind: "action" as const,
  system: null,
  connection: null,
  requires: [],
  parameters: [],
  itemKind: null,
  actsOn: ["*"],
  requiresWorkspace: false,
  workspaceSource: null,
  permissionProfile: "read-only" as const,
  agentInputs: ["approval_request"],
  emits: [],
};

export const reviewWorkspace: RegisteredWorkspace = {
  source: "test",
  repository: "owner/repo",
  contributions: [],
  config: Schema.decodeSync(WorkspaceConfig)({
    id: "repo",
    displayName: "repo",
    checkoutPath: "/repo",
    issueTracker: { type: "github" },
  }),
};

const postReviewEntry = decodeEntry("github.post-review");

export const reviewDocument = WorkflowDocument.make({
  ...document,
  workspaces: { _tag: "Every" },
  operations: document.operations.map((candidate) => ({
    ...candidate,
    transitions: candidate.transitions.map((transition) => ({
      ...transition,
      actions: [
        { entry: postReviewEntry, parameters: [{ id: "event", value: "comment" }] },
        { entry: waitForApprovalEntry, parameters: [] },
      ],
    })),
  })),
});

export const postReviewCatalogEntry = {
  key: postReviewEntry,
  name: "Post a review",
  kind: "action" as const,
  system: "github",
  connection: "github",
  requires: [],
  parameters: [{ id: "event", required: true, source: "fixed" as const, values: ["comment"] }],
  itemKind: null,
  actsOn: ["*"],
  requiresWorkspace: true,
  workspaceSource: "agent",
  permissionProfile: "read-only" as const,
  agentInputs: ["pull_request", "review_body", "review_comments"],
  emits: [],
} satisfies WorkflowCatalogEntry;

export const reviewOutput = {
  summary: "Review ready",
  stuck: false,
  answers: { done: "yes" },
  workspace: reviewWorkspace.config.id,
  inputs: {
    pull_request: "#826",
    review_body: "Looks good.",
    review_comments: [],
    approval_request: "Post this review?",
  },
};

export const workflowServiceFor = (
  publishedCopy: WorkflowDocument,
  entries: ReadonlyArray<WorkflowCatalogEntry> = [],
): WorkflowsService => ({
  ...workflowService,
  get: () => Effect.succeed({ ...workflowRecord, workingCopy: publishedCopy, publishedCopy }),
  catalog: workflowService.catalog.pipe(
    Effect.map((result) => ({
      ...result,
      catalog: { ...result.catalog, entries: [...result.catalog.entries, ...entries] },
    })),
  ),
});

export const documentWithTransition = (transition: {
  readonly when: ReadonlyArray<{ readonly question: WorkflowNodeId; readonly choice: WorkflowNodeId }>;
  readonly actions: ReadonlyArray<{
    readonly entry: WorkflowCatalogKey;
    readonly parameters: ReadonlyArray<never>;
  }>;
  readonly handOff: WorkflowNodeId | null;
}) => {
  const [summarize] = document.operations;
  if (summarize === undefined) return Effect.die("Missing test Operation");
  return Schema.decodeEffect(WorkflowDocument)({
    ...document,
    operations: [{ ...summarize, transitions: [transition] }],
  });
};

export const workflowServiceWith = (publishedCopy: WorkflowDocument): WorkflowsService => ({
  ...workflowService,
  list: Effect.succeed({
    workflows: [{ ...workflowRecord, workingCopy: publishedCopy, publishedCopy }],
    unreadable: [],
  }),
  get: () => Effect.succeed({ ...workflowRecord, workingCopy: publishedCopy, publishedCopy }),
});

export const issueSearchService = (baseCatalogResult: Effect.Success<WorkflowsService["catalog"]>) => {
  const createIssueEntry = decodeEntry("github.create-issue");
  const issueDocument = WorkflowDocument.make({
    ...document,
    operations: document.operations.map((candidate) => ({
      ...candidate,
      transitions: candidate.transitions.map((candidateTransition) => ({
        ...candidateTransition,
        actions: [{ entry: createIssueEntry, parameters: [] }],
      })),
    })),
  });
  return {
    ...workflowServiceWith(issueDocument),
    catalog: Effect.succeed({
      ...baseCatalogResult,
      catalog: {
        ...baseCatalogResult.catalog,
        entries: [
          ...baseCatalogResult.catalog.entries,
          {
            key: createIssueEntry,
            name: "Create an issue",
            kind: "action" as const,
            system: "github",
            connection: "github",
            requires: [],
            parameters: [],
            itemKind: null,
            actsOn: ["*"],
            requiresWorkspace: true,
            workspaceSource: "agent",
            permissionProfile: "read-only" as const,
            agentInputs: ["issue_title", "issue_body"],
            emits: [],
          },
        ],
      },
    }),
  } satisfies WorkflowsService;
};
