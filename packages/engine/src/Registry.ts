import * as Context from "effect/Context";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { WorkspaceConfig } from "./Workspace";

export interface LoadedWorkspace {
  readonly source: string;
  readonly value: unknown;
}

export interface WorkspaceFailure {
  readonly source: string;
  readonly message: string;
}

export interface LoadResult {
  readonly loaded: ReadonlyArray<LoadedWorkspace>;
  readonly failures: ReadonlyArray<WorkspaceFailure>;
}

export interface RegisteredWorkspace {
  readonly source: string;
  readonly config: WorkspaceConfig;
}

export interface RegistryState {
  readonly workspaces: ReadonlyArray<RegisteredWorkspace>;
  readonly failures: ReadonlyArray<WorkspaceFailure>;
}

export class WorkspaceRegistry extends Context.Service<WorkspaceRegistry, RegistryState>()(
  "engine/Registry/WorkspaceRegistry",
) {}

const decodeConfig = Schema.decodeUnknownResult(WorkspaceConfig);

const decode = (module: LoadedWorkspace) => ({
  source: module.source,
  outcome: decodeConfig(module.value),
});

export const buildRegistry = (result: LoadResult) => {
  const decoded = result.loaded.map(decode);
  const decodeFailures = decoded.flatMap((entry) =>
    Result.isFailure(entry.outcome) ? [{ source: entry.source, message: entry.outcome.failure.message }] : [],
  );
  return {
    workspaces: decoded.flatMap((entry) =>
      Result.isSuccess(entry.outcome) ? [{ source: entry.source, config: entry.outcome.success }] : [],
    ),
    failures: [...result.failures, ...decodeFailures],
  };
};
