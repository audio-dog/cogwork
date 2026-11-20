import type {
  IssueTrackerConfig,
  LocalContribution,
  SourceControlConfig,
  WorkspaceConfig,
  WorkspaceFailureInfo,
  WorkspaceRecord,
} from "@cogwork/contracts";

export interface WorkspaceIssueTrackerBinding {
  readonly config: Pick<WorkspaceConfig, "id" | "issueTracker" | "sourceControl">;
  readonly repository?: string;
}

export interface RegisteredWorkspace extends WorkspaceIssueTrackerBinding {
  readonly source: string;
  readonly config: WorkspaceConfig;
  readonly record?: WorkspaceRecord;
  readonly contributions: ReadonlyArray<LocalContribution>;
  readonly workspaceLimit?: number;
}

export interface RegisteredWorkspaceFailure extends WorkspaceFailureInfo {
  readonly issueTracker?: IssueTrackerConfig;
  readonly sourceControl?: SourceControlConfig;
  readonly repository?: string;
  readonly workspaceLimit?: number;
}

export interface RegistryState {
  readonly workspaces: ReadonlyArray<RegisteredWorkspace>;
  readonly failures: ReadonlyArray<RegisteredWorkspaceFailure>;
}

export const emptyRegistry: RegistryState = { workspaces: [], failures: [] };
