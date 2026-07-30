import type { WorkspaceConfig, WorkspaceEvent, WorkspaceFailureInfo } from "@clanker-forge/contracts";

export interface RegisteredWorkspace {
  readonly source: string;
  readonly config: WorkspaceConfig;
}

export interface RegistryState {
  readonly workspaces: ReadonlyArray<RegisteredWorkspace>;
  readonly failures: ReadonlyArray<WorkspaceFailureInfo>;
}

export const emptyRegistry: RegistryState = { workspaces: [], failures: [] };

export const projectEvent = (state: RegistryState, event: WorkspaceEvent): RegistryState => {
  if (event.type === "workspace.registered") {
    return {
      ...state,
      workspaces: [...state.workspaces, { source: event.source, config: event.config }],
    };
  }
  return {
    ...state,
    failures: [...state.failures, { source: event.source, message: event.message }],
  };
};
