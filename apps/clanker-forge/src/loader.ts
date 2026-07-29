import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { Registry } from "engine";

const configExtensions = new Set([".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"]);

class WorkspaceLoadError extends Data.TaggedError("WorkspaceLoadError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

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
    catch: (cause) => new WorkspaceLoadError({ message: `Cannot read config home ${configHome}`, cause }),
  }).pipe(
    Effect.map((entries) =>
      entries
        .filter((entry) => entry.isFile() && configExtensions.has(path.extname(entry.name)))
        .map((entry) => path.join(configHome, entry.name)),
    ),
  );

const importConfig = (source: string) =>
  Effect.tryPromise({
    try: () => import(pathToFileURL(source).href),
    catch: (cause) => new WorkspaceLoadError({ message: describeError(cause), cause }),
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
