import { AgUiEvent, agUiIsFileDiffEvent, agUiIsSubagentEvent, FILE_DIFF_EVENT } from "@cogwork/contracts";
import { DEFAULT_WORKSPACE_ROOT } from "@tanstack/ai-sandbox";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type {
  ExternalHarnessResolvedRequest,
  ExternalHarnessUsageEstimator,
} from "./external-harness-runtime";
import { scrubEvent } from "./external-harness-runtime-workspace";
import type { HarnessError } from "./harness";
import { ignored, watchWorktreeDiffs } from "./tools/file-diff-feed";
import { mergeFileDiffFeed } from "./tools/file-diff-feed-merge";
import { boundedDiff } from "./tools/file-diff-git";
import { openWorktreeSandbox, resolveBaseSha } from "./tools/sandbox";

const outputCharacters = (event: AgUiEvent) => {
  if (agUiIsSubagentEvent(event)) return 0;
  return AgUiEvent.guards.TEXT_MESSAGE_CONTENT(event) || AgUiEvent.guards.REASONING_MESSAGE_CONTENT(event)
    ? (event.delta?.length ?? 0)
    : 0;
};

const relativeToRoot = (path: string, root: string) => {
  const normalizedPath = path.replace(/^\/+/, "");
  const normalizedRoot = root.replace(/^\/+|\/+$/g, "");
  if (normalizedPath === normalizedRoot) return ".";
  const prefix = `${normalizedRoot}/`;
  return normalizedPath.startsWith(prefix) ? normalizedPath.slice(prefix.length) : path;
};

const normalizeFileDiffValue = (value: unknown, checkoutPath: string) => {
  if (typeof value !== "object" || value === null || !("path" in value)) return value;
  if (typeof value.path !== "string") return value;
  const workspacePath = relativeToRoot(value.path, DEFAULT_WORKSPACE_ROOT);
  return { ...value, path: relativeToRoot(workspacePath, checkoutPath) };
};

export const normalizeFileEvent = (event: AgUiEvent, checkoutPath: string) => {
  if (!AgUiEvent.guards.CUSTOM(event)) return event;
  const name = event.name === "file.changed" ? FILE_DIFF_EVENT : event.name;
  if (name !== FILE_DIFF_EVENT) return event;
  const normalized = { ...event, name, value: normalizeFileDiffValue(event.value, checkoutPath) };
  if (!agUiIsFileDiffEvent(normalized)) return event;
  // A native whole-worktree diff is unbounded at the source. The owned diff feed
  // holds the same client contract to one bound, so hold this path to it too
  // rather than persisting and rendering a multi-megabyte string.
  return { ...normalized, value: { ...normalized.value, diff: boundedDiff(normalized.value.diff) } };
};

export const publicFileEvent = (event: AgUiEvent) => {
  // A native file event that could not carry the shared contract keeps its native
  // name through `normalizeFileEvent`. TanStack's payload makes `diff` optional, so
  // this is a real shape, and it has no diff to show — drop it rather than persist
  // an event under a name no client reads.
  if (AgUiEvent.guards.CUSTOM(event) && event.name === "file.changed") return false;
  if (!agUiIsFileDiffEvent(event)) return true;
  // A touched-but-unchanged file still reports a change; an empty diff would render
  // as an activity entry with nothing in it.
  if (event.value.diff === "") return false;
  return !ignored(event.value.path);
};

export const preserveUsage: ExternalHarnessUsageEstimator = (_request, event) => event;

export const withUsage = (
  request: ExternalHarnessResolvedRequest,
  estimate: ExternalHarnessUsageEstimator,
  stream: Stream.Stream<AgUiEvent, HarnessError>,
) =>
  Stream.mapAccum(
    stream,
    () => 0,
    (characters, event): readonly [number, ReadonlyArray<AgUiEvent>] => {
      const next = characters + outputCharacters(event);
      return [next, [estimate(request, event, next)]];
    },
  );

export const checkoutFileDiffs = (
  checkoutPath: string,
  secretValues: ReadonlyArray<string>,
  stop: Effect.Effect<void>,
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const sandbox = yield* openWorktreeSandbox(checkoutPath);
      const baseSha = yield* resolveBaseSha(sandbox);
      return watchWorktreeDiffs(sandbox, baseSha, stop);
    }),
  ).pipe(Stream.map((event) => scrubEvent(event, secretValues)));

export const mergeCheckoutFileDiffs = Effect.fn("ExternalHarnessRuntime.mergeCheckoutFileDiffs")(function* <
  E,
  R,
>(
  harnessEvents: Stream.Stream<AgUiEvent, HarnessError>,
  fileDiffs: (stop: Effect.Effect<void>) => Stream.Stream<AgUiEvent, E, R>,
) {
  return yield* mergeFileDiffFeed(harnessEvents, fileDiffs, "checkout file-diff feed stopped");
});
