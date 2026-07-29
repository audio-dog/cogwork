import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Registry } from "engine";

const configSuffixes = [".workspace.ts", ".workspace.mts", ".workspace.cts"];

const isConfigFile = (name: string) => configSuffixes.some((suffix) => name.endsWith(suffix));

class WorkspaceLoadError extends Schema.TaggedErrorClass<WorkspaceLoadError>()("WorkspaceLoadError", {
  detail: Schema.String,
}) {
  override get message() {
    return this.detail;
  }
}

type ImportOutcome =
  | { readonly _tag: "loaded"; readonly source: string; readonly value: unknown }
  | { readonly _tag: "failed"; readonly source: string; readonly message: string };

const describeError = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const readDefault = (module: unknown) => {
  const record = module as { readonly default?: unknown };
  return record?.default ?? module;
};

const listConfigFiles = (configHome: string) =>
  Effect.tryPromise({
    try: () => fs.readdir(configHome, { withFileTypes: true }),
    catch: () => new WorkspaceLoadError({ detail: `Cannot read config home ${configHome}` }),
  }).pipe(
    Effect.map((entries) =>
      entries
        .filter((entry) => entry.isFile() && isConfigFile(entry.name))
        .map((entry) => path.join(configHome, entry.name)),
    ),
  );

const importConfig = (source: string) =>
  Effect.tryPromise({
    try: () => import(pathToFileURL(source).href),
    catch: (cause) => new WorkspaceLoadError({ detail: describeError(cause) }),
  }).pipe(
    Effect.map((module): ImportOutcome => ({ _tag: "loaded", source, value: readDefault(module) })),
    Effect.catchTag("WorkspaceLoadError", (error) =>
      Effect.succeed<ImportOutcome>({ _tag: "failed", source, message: error.message }),
    ),
  );

export const loadFromDisk = (configHome: string) =>
  listConfigFiles(configHome).pipe(
    Effect.flatMap((files) => Effect.forEach(files, importConfig)),
    Effect.map((outcomes) => ({
      loaded: outcomes.flatMap((o) => (o._tag === "loaded" ? [{ source: o.source, value: o.value }] : [])),
      failures: outcomes.flatMap((o) =>
        o._tag === "failed" ? [{ source: o.source, message: o.message }] : [],
      ),
    })),
    Effect.catchTag("WorkspaceLoadError", (error) =>
      Effect.logError("workspace loader failed", error).pipe(
        Effect.map(
          (): Registry.LoadResult => ({
            loaded: [],
            failures: [{ source: configHome, message: error.message }],
          }),
        ),
      ),
    ),
  );
