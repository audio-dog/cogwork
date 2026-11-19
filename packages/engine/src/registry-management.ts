import {
  type WorkspaceId,
  type WorkspaceRegistration,
  WorkspaceRegistrationError,
  type WorkspaceRegistryError,
  type WorkspaceUpdate,
} from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { RegisteredWorkspace, RegisteredWorkspaceFailure } from "./projector";
import { workspaceManagementFailure } from "./registry-errors";

export interface WorkspaceManagementService {
  readonly register: (
    registration: WorkspaceRegistration,
  ) => Effect.Effect<WorkspaceRegistrationChange, WorkspaceRegistrationError>;
  readonly deregister: (workspace: WorkspaceId) => Effect.Effect<WorkspaceId, WorkspaceRegistryError>;
  readonly update: (
    workspace: WorkspaceId,
    update: WorkspaceUpdate,
  ) => Effect.Effect<WorkspaceRegistrationChange, WorkspaceRegistryError>;
  readonly rebind: (
    workspace: WorkspaceId,
    checkoutPath: string,
  ) => Effect.Effect<WorkspaceRegistrationChange, WorkspaceRegistryError>;
}

export type WorkspaceRegistrationChange =
  | { readonly _tag: "Registered"; readonly workspace: RegisteredWorkspace }
  | { readonly _tag: "Failed"; readonly failure: RegisteredWorkspaceFailure };

export class WorkspaceManagement extends Context.Service<WorkspaceManagement, WorkspaceManagementService>()(
  "@cogwork/engine/registry-management/WorkspaceManagement",
) {}

export const managementReadOnlyLayer = Layer.succeed(WorkspaceManagement, {
  register: () => Effect.fail(new WorkspaceRegistrationError({ message: "Workspace registry is read-only" })),
  deregister: (workspace) =>
    Effect.fail(
      workspaceManagementFailure(workspace, "deregister workspace", "Workspace registry is read-only"),
    ),
  update: (workspace) =>
    Effect.fail(workspaceManagementFailure(workspace, "update workspace", "Workspace registry is read-only")),
  rebind: (workspace) =>
    Effect.fail(
      workspaceManagementFailure(workspace, "re-bind workspace", "Workspace registry is read-only"),
    ),
});
