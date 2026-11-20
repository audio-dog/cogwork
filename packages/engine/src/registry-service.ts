import type { WorkspaceRegistrationError } from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import type { RegistryState } from "./projector";

export interface WorkspaceRegistryService {
  readonly state: Effect.Effect<RegistryState>;
  readonly refresh: Effect.Effect<RegistryState, WorkspaceRegistrationError>;
}

export class WorkspaceRegistry extends Context.Service<WorkspaceRegistry, WorkspaceRegistryService>()(
  "@cogwork/engine/registry-service/WorkspaceRegistry",
) {}

export const readOnlyRegistry = (state: RegistryState): WorkspaceRegistryService => ({
  state: Effect.succeed(state),
  refresh: Effect.succeed(state),
});
