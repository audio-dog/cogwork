import { type WorkspaceId, WorkspaceRegistrationError, WorkspaceRegistryError } from "@cogwork/contracts";
import * as Schema from "effect/Schema";

export const workspaceNotFound = (workspace: WorkspaceId) =>
  new WorkspaceRegistryError({
    reason: "not-found",
    workspace,
    message: `Workspace "${workspace}" not found`,
  });

export const workspaceManagementFailure = (workspace: WorkspaceId, operation: string, message: string) =>
  new WorkspaceRegistryError({ reason: "management-failed", workspace, operation, message });

export const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const registrationError = (error: unknown) =>
  new WorkspaceRegistrationError({ message: messageOf(error) });

const isWorkspaceRegistryError = Schema.is(WorkspaceRegistryError);

export const managementError = (workspace: WorkspaceId, operation: string) => (error: unknown) =>
  isWorkspaceRegistryError(error)
    ? error
    : workspaceManagementFailure(workspace, operation, messageOf(error));
