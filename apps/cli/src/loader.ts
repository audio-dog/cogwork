import { pathToFileURL } from "node:url";
import type { Registry } from "@cogwork/engine";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const configSuffixes = [".workspace.ts", ".workspace.mts", ".workspace.cts"];

const isConfigFile = (name: string) => configSuffixes.some((suffix) => name.endsWith(suffix));

class WorkspaceLoadError extends Schema.TaggedError<WorkspaceLoadError>()("WorkspaceLoadError", {
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
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const entries = yield* fs
      .readDirectory(configHome)
      .pipe(
        Effect.mapError(() => new WorkspaceLoadError({ detail: `Cannot read config home ${configHome}` })),
      );
    return entries.filter(isConfigFile).map((name) => path.join(configHome, name));
  });

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
