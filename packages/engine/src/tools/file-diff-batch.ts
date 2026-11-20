// @effect-diagnostics-next-line nodeBuiltinImport:off
import { createHash } from "node:crypto";

import type { SandboxFileEvent } from "@tanstack/ai-sandbox";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";

import { type ToolError, toolError } from "./errors";
import {
  appendDiffOutput,
  collectProcessOutput,
  completeDiffOutput,
  type DiffOutput,
  diffFromOutput,
  directoryAtBase,
  exec,
  execFailure,
  fileDiffExecDuration,
  gitCommand,
  gitDiffCommand,
  nextChunk,
  type PendingDiffOutput,
  pendingDiffOutput,
  quote,
  relTo,
  streamDiff,
  trackedAtBase,
} from "./file-diff-git";
import type { WorktreeSandbox } from "./sandbox";

export const fileDiffSettledEvents = Metric.counter("cogwork_file_diff_settled_events_total", {
  description: "Settled file events entering diff computation.",
});
export const fileDiffBatches = Metric.counter("cogwork_file_diff_batches_total", {
  description: "Batches of settled file events submitted for diff computation.",
});

interface BatchDiffHeader {
  readonly paths: ReadonlyArray<string>;
  readonly patch: string;
}

const rawPatchSeparator = "\0\0";

const batchDiffPaths = (raw: string) => raw.split("\0").filter((_field, index) => index % 2 === 1);

const readBatchDiffHeader = (
  chunks: AsyncIterator<string>,
  buffered = "",
): Effect.Effect<BatchDiffHeader, ToolError> =>
  nextChunk(chunks).pipe(
    Effect.flatMap((next) => {
      if (next.done && buffered === "") return Effect.succeed({ paths: [], patch: "" });
      if (next.done) {
        return Effect.fail(toolError("exec-failed", "git diff returned an incomplete raw header"));
      }
      const output = `${buffered}${next.value}`;
      const separator = output.indexOf(rawPatchSeparator);
      if (separator !== -1) {
        return Effect.succeed({
          paths: batchDiffPaths(output.slice(0, separator)),
          patch: output.slice(separator + rawPatchSeparator.length),
        });
      }
      return readBatchDiffHeader(chunks, output);
    }),
  );

interface BatchPatchState {
  readonly currentPath: string | undefined;
  readonly remainingPaths: ReadonlyArray<string>;
  readonly current: PendingDiffOutput;
  readonly completed: ReadonlyMap<string, DiffOutput>;
  readonly tail: string;
  readonly invalid: boolean;
}

const ansiEscape = String.fromCharCode(27);
const patchBoundary = new RegExp(`(?:^|\\n)(?:${ansiEscape}\\[[0-9;]*m)*diff --git `);
const ansiPrefixes = new RegExp(`^(?:${ansiEscape}\\[[0-9;]*m)*`);
const partialAnsiPrefix = new RegExp(`^${ansiEscape}(?:\\[[0-9;]*)?$`);
const diffHeader = "diff --git ";

// `--no-renames` preserves one raw path per patch. `-z` terminates the raw path list with two NULs;
// colored patch headers may start with SGR sequences that must remain in the emitted payload.
const completeBatchPatch = (state: BatchPatchState, value: string) => {
  if (state.currentPath === undefined) return { ...state, invalid: true };
  return {
    currentPath: state.remainingPaths[0],
    remainingPaths: state.remainingPaths.slice(1),
    current: pendingDiffOutput(),
    completed: new Map([
      ...state.completed,
      [state.currentPath, completeDiffOutput(appendDiffOutput(state.current, value))],
    ]),
    tail: "",
    invalid: state.invalid,
  };
};

const couldStartPatchBoundary = (value: string) => {
  const withoutAnsi = value.replace(ansiPrefixes, "");
  return partialAnsiPrefix.test(withoutAnsi) || diffHeader.startsWith(withoutAnsi);
};

const findPatchBoundary = (value: string) => {
  const match = patchBoundary.exec(value);
  if (match === null) return null;
  return {
    start: match.index + (match[0].startsWith("\n") ? 1 : 0),
    end: match.index + match[0].length,
  };
};

const nextPatchStart = (state: BatchPatchState, output: string) => {
  const first = findPatchBoundary(output);
  if (first === null) return null;
  if (first.start > 0 || state.current.byteLength > 0) return first.start;
  const following = findPatchBoundary(output.slice(first.end));
  return following === null ? null : first.end + following.start;
};

const consumeBatchPatch = (state: BatchPatchState, value: string): BatchPatchState => {
  const output = `${state.tail}${value}`;
  const boundary = nextPatchStart(state, output);
  if (boundary !== null) {
    const completed = completeBatchPatch(state, output.slice(0, boundary));
    return consumeBatchPatch(completed, output.slice(boundary));
  }
  const lastLineStart = output.lastIndexOf("\n") + 1;
  const consumedLength = couldStartPatchBoundary(output.slice(lastLineStart)) ? lastLineStart : output.length;
  return {
    ...state,
    current: appendDiffOutput(state.current, output.slice(0, consumedLength)),
    tail: output.slice(consumedLength),
  };
};

const finishBatchPatch = (state: BatchPatchState) => {
  const completed = state.currentPath === undefined ? state : completeBatchPatch(state, state.tail);
  const mismatched =
    completed.invalid ||
    completed.currentPath !== undefined ||
    completed.remainingPaths.length > 0 ||
    completed.tail !== "";
  return mismatched ? Option.none<ReadonlyMap<string, DiffOutput>>() : Option.some(completed.completed);
};

const readBatchPatches = (
  chunks: AsyncIterator<string>,
  state: BatchPatchState,
): Effect.Effect<Option.Option<ReadonlyMap<string, DiffOutput>>, ToolError> =>
  nextChunk(chunks).pipe(
    Effect.flatMap((next) =>
      next.done
        ? Effect.succeed(finishBatchPatch(state))
        : readBatchPatches(chunks, consumeBatchPatch(state, next.value)),
    ),
  );

const readBatchDiffOutput = Effect.fn("Tools.readBatchDiffOutput")(function* (chunks: AsyncIterator<string>) {
  const header = yield* readBatchDiffHeader(chunks);
  if (header.paths.length === 0) return Option.some(new Map<string, DiffOutput>());
  const state = consumeBatchPatch(
    {
      currentPath: header.paths[0],
      remainingPaths: header.paths.slice(1),
      current: pendingDiffOutput(),
      completed: new Map(),
      tail: "",
      invalid: false,
    },
    header.patch,
  );
  return yield* readBatchPatches(chunks, state);
});

const streamBatchDiff = Effect.fn("Tools.streamBatchDiff")(function* (
  sandbox: WorktreeSandbox,
  baseSha: string,
  paths: ReadonlyArray<string>,
) {
  if (paths.length === 0) {
    return Option.some(new Map<string, { readonly diff: string; readonly fingerprint: string }>());
  }
  const command = `${gitDiffCommand} --raw -z --patch --no-renames ${quote(baseSha)} -- ${paths.map(quote).join(" ")}`;
  const result = yield* collectProcessOutput(sandbox, command, readBatchDiffOutput).pipe(
    Effect.trackDuration(fileDiffExecDuration),
  );
  if (result.exitCode !== 0) {
    return yield* execFailure(command, paths[0] ?? "", {
      stdout: "",
      stderr: result.stderr,
      exitCode: result.exitCode,
    });
  }
  return Option.map(
    result.stdout,
    (outputs) =>
      new Map(
        [...outputs].map(([path, output]) => [
          path,
          { diff: diffFromOutput(output), fingerprint: output.fingerprint },
        ]),
      ),
  );
});

export interface FileDiff {
  readonly path: string;
  readonly diff: string;
  readonly fingerprint: string;
}

interface BaseEntry {
  readonly directory: boolean;
}

const allPathsExternalDiff = "all-paths-external-diff";

export type ExternalDiffScope = typeof allPathsExternalDiff | ReadonlySet<string>;

export const externalDiffScope = Effect.fn("Tools.externalDiffScope")(function* (sandbox: WorktreeSandbox) {
  const hasEnvironmentExternalDiff = yield* Config.String("GIT_EXTERNAL_DIFF").pipe(
    Config.option,
    Effect.match({
      onFailure: () => true,
      onSuccess: (value) => Option.isSome(value) && value.value !== "",
    }),
  );
  if (hasEnvironmentExternalDiff) return allPathsExternalDiff;
  const configCommand = "git config -z --get-regexp '^diff\\.(external|.*\\.command)$'";
  const config = yield* exec(sandbox, configCommand);
  if (config.exitCode !== 0 && config.exitCode !== 1) {
    return yield* execFailure(configCommand, "", config);
  }
  const settings = new Map(
    config.stdout
      .split("\0")
      .filter((entry) => entry !== "")
      .map((entry) => {
        const separator = entry.indexOf("\n");
        return [entry.slice(0, separator), entry.slice(separator + 1)] satisfies [string, string];
      }),
  );
  if (settings.has("diff.external")) return allPathsExternalDiff;
  return new Set([...settings.keys()].flatMap((key) => /^diff\.(.+)\.command$/.exec(key)?.[1] ?? []));
});

const externalDiffConfigured = Effect.fn("Tools.externalDiffConfigured")(function* (
  sandbox: WorktreeSandbox,
  scope: ExternalDiffScope,
  paths: ReadonlyArray<string>,
) {
  if (scope === allPathsExternalDiff) return true;
  if (scope.size === 0) return false;
  const attributeCommand = `git check-attr -z diff -- ${paths.map((path) => quote(`./${path}`)).join(" ")}`;
  const attributes = yield* exec(sandbox, attributeCommand);
  if (attributes.exitCode !== 0) {
    return yield* execFailure(attributeCommand, paths[0] ?? "", attributes);
  }
  return attributes.stdout.split("\0").some((value, index) => index % 3 === 2 && scope.has(value));
});

const baseEntries = Effect.fn("Tools.baseEntries")(function* (
  sandbox: WorktreeSandbox,
  baseSha: string,
  paths: ReadonlyArray<string>,
) {
  const command = `${gitCommand} ls-tree -z ${quote(baseSha)} -- ${paths.map(quote).join(" ")}`;
  const result = yield* exec(sandbox, command);
  if (result.exitCode !== 0) return yield* execFailure(command, paths[0] ?? "", result);
  return new Map(
    result.stdout
      .split("\0")
      .filter((entry) => entry !== "")
      .map((entry) => {
        const separator = entry.indexOf("\t");
        const metadata = entry.slice(0, separator).split(" ");
        return [entry.slice(separator + 1), { directory: metadata[1] === "tree" }] satisfies [
          string,
          BaseEntry,
        ];
      }),
  );
});

const emptyDiff = () => ({
  diff: "",
  fingerprint: createHash("sha256").digest("base64"),
});

const streamAddPatch = (sandbox: WorktreeSandbox, rel: string) =>
  streamDiff(sandbox, `${gitDiffCommand} --no-index -- /dev/null ${quote(rel)}`, rel, new Set([0, 1]));

const resolveFileDiff = Effect.fn("Tools.resolveFileDiff")(function* (
  sandbox: WorktreeSandbox,
  baseSha: string,
  event: SandboxFileEvent,
  path: string,
  trackedDiff: { readonly diff: string; readonly fingerprint: string },
  knownTracked?: boolean,
) {
  if (trackedDiff.diff !== "") return { path, ...trackedDiff };
  if (event.type === "delete") return { path, ...emptyDiff() };
  const tracked = knownTracked ?? (yield* trackedAtBase(sandbox, baseSha, path));
  if (tracked) return { path, ...emptyDiff() };
  return { path, ...(yield* streamAddPatch(sandbox, path)) };
});

const computeFileDiff = Effect.fn("Tools.computeFileDiff")(function* (
  sandbox: WorktreeSandbox,
  baseSha: string,
  event: SandboxFileEvent,
) {
  const path = relTo(event.path);
  if (event.type === "delete" && baseSha === "") return { path, ...emptyDiff() };
  if (baseSha === "") return { path, ...(yield* streamAddPatch(sandbox, path)) };
  if (event.type === "delete" && (yield* directoryAtBase(sandbox, baseSha, path))) {
    return { path, ...emptyDiff() };
  }
  const command = `${gitDiffCommand} ${quote(baseSha)} -- ${quote(path)}`;
  const trackedDiff = yield* streamDiff(sandbox, command, path, new Set([0]));
  return yield* resolveFileDiff(sandbox, baseSha, event, path, trackedDiff);
});

export const computeFileDiffBatch = Effect.fn("Tools.computeFileDiffBatch")(function* (
  sandbox: WorktreeSandbox,
  baseSha: string,
  externalDiff: Effect.Effect<ExternalDiffScope, ToolError>,
  events: ReadonlyArray<SandboxFileEvent>,
) {
  yield* Metric.update(fileDiffBatches, 1);
  yield* Metric.update(fileDiffSettledEvents, events.length);
  const computeIndividually = () =>
    Effect.forEach(events, (event) => computeFileDiff(sandbox, baseSha, event));
  if (events.length === 1 || baseSha === "") {
    return yield* computeIndividually();
  }
  const files = events.map((event) => ({ event, path: relTo(event.path) }));
  const paths = files.map(({ path }) => path);
  const scope = yield* externalDiff;
  if (yield* externalDiffConfigured(sandbox, scope, paths)) return yield* computeIndividually();
  const entries = yield* baseEntries(sandbox, baseSha, paths);
  const diffablePaths = files.filter(({ path }) => !entries.get(path)?.directory).map(({ path }) => path);
  const trackedDiffs = yield* streamBatchDiff(sandbox, baseSha, diffablePaths);
  if (Option.isNone(trackedDiffs)) return yield* computeIndividually();
  return yield* Effect.forEach(files, ({ event, path }) => {
    const baseEntry = entries.get(path);
    if (!baseEntry?.directory) {
      const trackedDiff = trackedDiffs.value.get(path);
      return resolveFileDiff(
        sandbox,
        baseSha,
        event,
        path,
        trackedDiff ?? emptyDiff(),
        baseEntry !== undefined,
      );
    }
    if (event.type === "delete") return Effect.succeed({ path, ...emptyDiff() });
    return computeFileDiff(sandbox, baseSha, event);
  });
});
