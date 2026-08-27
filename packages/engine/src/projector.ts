import type { WorkspaceConfig, WorkspaceFailureInfo } from "@cogwork/contracts";

export interface RegisteredWorkspace {
  readonly source: string;
  readonly config: WorkspaceConfig;
  readonly workspaceLimit?: number;
}

export interface RegisteredWorkspaceFailure extends WorkspaceFailureInfo {
  readonly workspaceLimit?: number;
}

export interface RegistryState {
  readonly workspaces: ReadonlyArray<RegisteredWorkspace>;
  readonly failures: ReadonlyArray<RegisteredWorkspaceFailure>;
}

export const emptyRegistry: RegistryState = { workspaces: [], failures: [] };
