import type { RegistryState, WorkspaceIssueTrackerBinding } from "./projector";

export const findWorkspace = (registry: RegistryState, id: string) =>
  registry.workspaces.find((workspace) => workspace.config.id === id);

export const findWorkspaceIssueTrackerBinding = (registry: RegistryState, id: string) => {
  const workspace = findWorkspace(registry, id);
  if (workspace !== undefined) return workspace;
  const failure = registry.failures.find((candidate) => candidate.id === id);
  if (failure?.id === undefined || failure.issueTracker === undefined) return undefined;
  return {
    config: { id: failure.id, issueTracker: failure.issueTracker },
    ...(failure.repository ? { repository: failure.repository } : {}),
  } satisfies WorkspaceIssueTrackerBinding;
};

export const findWorkspaceIssueTracker = (registry: RegistryState, id: string) =>
  findWorkspaceIssueTrackerBinding(registry, id)?.config.issueTracker;
