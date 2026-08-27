import type { WorkspaceConfig, WorkspaceFailureInfo } from "@cogwork/contracts";

export interface RegisteredWorkspace {
  readonly source: string;
  readonly config: WorkspaceConfig;
  readonly workspaceLimit?: number;
}

export interface RegistryState {
  readonly workspaces: ReadonlyArray<RegisteredWorkspace>;
  readonly failures: ReadonlyArray<WorkspaceFailureInfo>;
}

export const emptyRegistry: RegistryState = { workspaces: [], failures: [] };
