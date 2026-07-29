import type { WorkspaceFailureInfo } from "contracts";
import * as Context from "effect/Context";
import { decide, type WorkspaceCommand } from "./decider";
import { emptyRegistry, projectEvent, type RegisteredWorkspace, type RegistryState } from "./projector";

export { decide, type WorkspaceCommand } from "./decider";
export { emptyRegistry, projectEvent } from "./projector";
export type { RegisteredWorkspace, RegistryState };

export interface LoadedWorkspace {
  readonly source: string;
  readonly value: unknown;
}

export interface LoadResult {
  readonly loaded: ReadonlyArray<LoadedWorkspace>;
  readonly failures: ReadonlyArray<WorkspaceFailureInfo>;
}

export class WorkspaceRegistry extends Context.Service<WorkspaceRegistry, RegistryState>()(
  "engine/Registry/WorkspaceRegistry",
) {}

const toCommands = (result: LoadResult) => [
  ...result.loaded.map(
    (module): WorkspaceCommand => ({
      type: "register-workspace",
      source: module.source,
      module: module.value,
    }),
  ),
  ...result.failures.map(
    (failure): WorkspaceCommand => ({
      type: "record-import-failure",
      source: failure.source,
      message: failure.message,
    }),
  ),
];

const applyCommand = (state: RegistryState, command: WorkspaceCommand) =>
  decide(state, command).reduce(projectEvent, state);

export const buildRegistry = (result: LoadResult): RegistryState =>
  toCommands(result).reduce(applyCommand, emptyRegistry);
