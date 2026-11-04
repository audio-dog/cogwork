import type { WorkflowCatalogEntry, WorkflowOption, WorkspaceId } from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import type { SourceFailure } from "./trigger-source";

/** Reads one list for one workspace, or for no workspace when the list does not depend on one. */
export type OptionReader = (
  workspace: WorkspaceId | undefined,
) => Effect.Effect<ReadonlyArray<WorkflowOption>, SourceFailure>;

/**
 * The lists one system can read, keyed by parameter id. Every catalog entry in the system's key
 * namespace (`github.add-label`, `github.issue-has-label`) shares the reader for its parameter.
 */
export interface SystemOptions {
  readonly system: string;
  readonly readers: Readonly<Record<string, OptionReader>>;
}

const namespaceOf = (entry: WorkflowCatalogEntry) => entry.key.split(".", 1)[0] ?? "";

export const mergeOptions = (listed: ReadonlyArray<ReadonlyArray<WorkflowOption>>) => [
  ...listed
    .flat()
    .reduce((byValue, option) => {
      const current = byValue.get(option.value);
      return byValue.set(option.value, {
        ...option,
        listedIn: [...new Set([...(current?.listedIn ?? []), ...option.listedIn])],
      });
    }, new Map<string, WorkflowOption>())
    .values(),
];

export const makeWorkflowOptions = (systems: ReadonlyArray<SystemOptions>) => {
  const readers = new Map(
    systems.flatMap(({ system, readers: byParameter }) =>
      Object.entries(byParameter).map(([parameter, reader]) => [`${system}/${parameter}`, reader] as const),
    ),
  );

  const list = (entry: WorkflowCatalogEntry, parameterId: string, workspaces: ReadonlyArray<WorkspaceId>) => {
    const parameter = entry.parameters.find(({ id }) => id === parameterId);
    if (parameter === undefined) return Effect.succeed([]);
    if (parameter.source !== "live") {
      return Effect.succeed(parameter.values.map((value) => ({ value, name: value, listedIn: workspaces })));
    }
    const reader = readers.get(`${namespaceOf(entry)}/${parameterId}`);
    if (reader === undefined) return Effect.succeed([]);
    const reads = workspaces.length === 0 ? [undefined] : workspaces;
    return Effect.forEach(reads, (workspace) =>
      reader(workspace).pipe(Effect.catchTag("SourceFailure", () => Effect.succeed([]))),
    ).pipe(Effect.map(mergeOptions));
  };

  return { list };
};
