import { type Board, McpSkill, type WorkspaceId, WorkspaceState, WorkspaceUpdate } from "@cogwork/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export interface WorkspaceRecordDraft {
  readonly displayName: string;
  readonly checkoutPath: string;
  readonly issueTrackerType: "github" | "linear";
  readonly issueTrackerConnectionId: string;
  readonly teams: string;
  readonly organization: string;
  readonly assigneeAllowlist: string;
  readonly trackerBotAllowlist: string;
  readonly priorityFieldId: string;
  readonly linearHistory: boolean;
  readonly sourceControlType: "none" | "github";
  readonly sourceControlConnectionId: string;
  readonly sourceControlBotAllowlist: string;
  readonly worktreeRoot: string;
  readonly worktreeRemote: string;
  readonly worktreeBaseBranch: string;
  readonly worktreeLinkPaths: string;
  readonly worktreeSetup: string;
  readonly worktreeReapAfterMillis: string;
  readonly concurrency: string;
  readonly mcpSkills: string;
}

export const emptyDraft: WorkspaceRecordDraft = {
  displayName: "",
  checkoutPath: "",
  issueTrackerType: "github",
  issueTrackerConnectionId: "unbound",
  teams: "",
  organization: "",
  assigneeAllowlist: "",
  trackerBotAllowlist: "",
  priorityFieldId: "",
  linearHistory: false,
  sourceControlType: "none",
  sourceControlConnectionId: "unbound",
  sourceControlBotAllowlist: "",
  worktreeRoot: "",
  worktreeRemote: "",
  worktreeBaseBranch: "",
  worktreeLinkPaths: "",
  worktreeSetup: "",
  worktreeReapAfterMillis: "",
  concurrency: "",
  mcpSkills: "[]",
};

const joined = (values: readonly string[] | undefined, separator = ", ") => values?.join(separator) ?? "";
const encodeMcpSkills = Schema.encodeSync(Schema.fromJsonString(Schema.Array(McpSkill)));
const decodeMcpSkills = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(McpSkill)));
const decodeWorkspaceUpdate = Schema.decodeUnknownOption(WorkspaceUpdate);

export const changedFieldCount = (draft: WorkspaceRecordDraft, against: WorkspaceRecordDraft) =>
  (Object.keys(draft) as ReadonlyArray<keyof WorkspaceRecordDraft>).filter(
    (key) => JSON.stringify(draft[key]) !== JSON.stringify(against[key]),
  ).length;

const draftFromRecord = (record: WorkspaceUpdate & { readonly checkoutPath: string }) => {
  const tracker = record.issueTracker;
  const sourceControl = record.sourceControl;
  const worktrees = record.worktrees;
  return {
    displayName: record.displayName,
    checkoutPath: record.checkoutPath,
    issueTrackerType: tracker.type === "linear" ? "linear" : "github",
    issueTrackerConnectionId: tracker.connectionId,
    teams: joined(tracker.teams),
    organization: tracker.organization ?? "",
    assigneeAllowlist: joined(tracker.assigneeAllowlist),
    trackerBotAllowlist: joined(tracker.botAllowlist),
    priorityFieldId: tracker.priority?.field.toString() ?? "",
    linearHistory: record.linearHistory,
    sourceControlType: sourceControl?.type === "github" ? "github" : "none",
    sourceControlConnectionId: sourceControl?.connectionId ?? "unbound",
    sourceControlBotAllowlist: joined(sourceControl?.botAllowlist),
    worktreeRoot: worktrees?.root ?? "",
    worktreeRemote: worktrees?.remote ?? "",
    worktreeBaseBranch: worktrees?.baseBranch ?? "",
    worktreeLinkPaths: joined(worktrees?.linkPaths, "\n"),
    worktreeSetup: joined(worktrees?.setup, "\n"),
    worktreeReapAfterMillis: worktrees?.reapAfterMillis?.toString() ?? "",
    concurrency: record.concurrency?.toString() ?? "",
    mcpSkills: encodeMcpSkills(record.mcpSkills ?? []),
  } satisfies WorkspaceRecordDraft;
};

export const seededDraft = (workspace: WorkspaceState): WorkspaceRecordDraft =>
  WorkspaceState.match(workspace, {
    Registered: ({ record }) => draftFromRecord(record),
    Failed: ({ displayName, source }) => ({
      ...emptyDraft,
      displayName: displayName ?? "",
      checkoutPath: source,
    }),
  });

const optional = (value: string) => value.trim() || undefined;
const list = (value: string) => {
  const values = value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return values.length > 0 ? values : undefined;
};
const lines = (value: string) => {
  const values = value
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return values.length > 0 ? values : undefined;
};
const positiveNumber = (value: string) => {
  if (!value.trim()) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : Number.NaN;
};
const priorityFrom = (draft: WorkspaceRecordDraft) => {
  if (!draft.priorityFieldId.trim()) return undefined;
  return { field: positiveNumber(draft.priorityFieldId) };
};
const missingConnectionError = (draft: WorkspaceRecordDraft) => {
  if (draft.issueTrackerConnectionId === "unbound") return "Choose an issue tracker Connection.";
  if (draft.sourceControlType === "github" && draft.sourceControlConnectionId === "unbound") {
    return "Choose a source control Connection.";
  }
  return null;
};

export const workspaceRecordDraftError = (draft: WorkspaceRecordDraft) =>
  missingConnectionError(draft) ?? "Check the workspace fields. JSON and positive numbers must be valid.";

const connectionsAreBound = (draft: WorkspaceRecordDraft) => missingConnectionError(draft) === null;

export const workspaceUpdateFromDraft = (draft: WorkspaceRecordDraft) => {
  if (!connectionsAreBound(draft)) return null;
  const mcpSkills = Option.getOrUndefined(decodeMcpSkills(draft.mcpSkills.trim() || "[]"));
  if (!mcpSkills) return null;
  const worktrees = {
    root: optional(draft.worktreeRoot),
    remote: optional(draft.worktreeRemote),
    baseBranch: optional(draft.worktreeBaseBranch),
    linkPaths: lines(draft.worktreeLinkPaths),
    setup: lines(draft.worktreeSetup),
    reapAfterMillis: positiveNumber(draft.worktreeReapAfterMillis),
  };
  const hasWorktrees = Object.values(worktrees).some((value) => value !== undefined);
  return Option.getOrNull(
    decodeWorkspaceUpdate({
      displayName: draft.displayName,
      issueTracker: {
        type: draft.issueTrackerType,
        connectionId: draft.issueTrackerConnectionId,
        teams: list(draft.teams),
        organization: optional(draft.organization),
        assigneeAllowlist: list(draft.assigneeAllowlist),
        botAllowlist: list(draft.trackerBotAllowlist),
        priority: priorityFrom(draft),
      },
      sourceControl:
        draft.sourceControlType === "github"
          ? {
              type: "github",
              connectionId: draft.sourceControlConnectionId,
              botAllowlist: list(draft.sourceControlBotAllowlist),
            }
          : undefined,
      mcpSkills,
      linearHistory: draft.linearHistory,
      worktrees: hasWorktrees ? worktrees : undefined,
      concurrency: positiveNumber(draft.concurrency),
    }),
  );
};

export const draftAfterSubmission = (
  draft: WorkspaceRecordDraft,
  checkoutPath: string,
  update: WorkspaceUpdate | null,
) => {
  if (!update) return { ...draft, checkoutPath };
  return draftFromRecord({ ...update, checkoutPath });
};

export const workspaceRecordWritable = (workspace: WorkspaceState) =>
  WorkspaceState.guards.Registered(workspace);

export const workspaceIdentity = (workspace: WorkspaceState) =>
  WorkspaceState.match(workspace, {
    Registered: ({ id }) => id,
    Failed: ({ id }) => id ?? null,
  });

export const workspaceKey = (workspace: WorkspaceState) =>
  WorkspaceState.match(workspace, {
    Registered: ({ id }) => id,
    Failed: ({ id, source }) => id ?? source,
  });

export const workspaceLabel = (workspace: WorkspaceState) =>
  WorkspaceState.match(workspace, {
    Registered: ({ displayName }) => displayName,
    Failed: ({ displayName, id, source }) => displayName ?? id ?? source,
  });

export const workspaceLabelById = (board: Board, workspace: WorkspaceId) => {
  const state = board.workspaces.get(workspace);
  return state ? workspaceLabel(state) : workspace;
};

export interface WorkspaceHealth {
  readonly tone: "ok" | "failed";
  readonly label: string;
  readonly detail: string;
}

export const workspaceHealth = (workspace: WorkspaceState, dangling: boolean): WorkspaceHealth => {
  if (WorkspaceState.guards.Failed(workspace))
    return { tone: "failed", label: "Workspace input failed", detail: workspace.message };
  if (dangling)
    return {
      tone: "failed",
      label: "Connection removed",
      detail: "Establish it again on Connections to start polling.",
    };
  return { tone: "ok", label: "Registered", detail: "Trigger sources read this workspace." };
};
