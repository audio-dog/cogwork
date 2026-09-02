import { Session } from "node:inspector/promises";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { openSynchronousFileWriter } from "./synchronous-file-writer";

export const ProcessProfileInput = Schema.TaggedUnion({
  HeapSnapshot: {
    directory: Schema.String,
  },
  CpuProfile: {
    directory: Schema.String,
    durationMillis: Schema.optionalKey(Schema.Finite),
  },
});
export type ProcessProfileInput = typeof ProcessProfileInput.Type;

export class ProcessProfileError extends Schema.TaggedError<ProcessProfileError>()("ProcessProfileError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

export interface ProcessInspector {
  readonly takeHeapSnapshot: (write: (chunk: string) => unknown) => Effect.Effect<void, ProcessProfileError>;
  readonly startCpuProfile: Effect.Effect<void, ProcessProfileError>;
  readonly stopCpuProfile: Effect.Effect<unknown, ProcessProfileError>;
}

export interface ProcessProfilerPlatform {
  readonly pid: number;
  readonly joinPath: (...segments: ReadonlyArray<string>) => string;
  readonly currentTimeMillis: Effect.Effect<number>;
  readonly openInspector: Effect.Effect<ProcessInspector, ProcessProfileError, Scope.Scope>;
  readonly ensureDirectory: (directory: string) => Effect.Effect<void, ProcessProfileError>;
  readonly writeFile: (path: string, contents: string) => Effect.Effect<void, ProcessProfileError>;
  readonly writeChunks: (
    path: string,
    produce: (write: (chunk: string) => unknown) => Effect.Effect<void, ProcessProfileError>,
  ) => Effect.Effect<void, ProcessProfileError>;
}

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const profilePath = (platform: ProcessProfilerPlatform, input: ProcessProfileInput, timestamp: number) =>
  platform.joinPath(
    input.directory,
    ProcessProfileInput.match(input, {
      HeapSnapshot: () => `Heap.${platform.pid}.${timestamp}.heapsnapshot`,
      CpuProfile: () => `CPU.${platform.pid}.${timestamp}.cpuprofile`,
    }),
  );

const profileError = (operation: string) => (cause: unknown) =>
  ProcessProfileError.make({ operation, cause });
const inspectorCommandTimeout = "5 seconds";
const heapSnapshotTimeout = "110 seconds";

export const makeProcessProfiler = (platform: ProcessProfilerPlatform) => {
  const captureHeapSnapshot = (path: string, inspector: ProcessInspector) =>
    platform.writeChunks(path, inspector.takeHeapSnapshot).pipe(Effect.map(() => path));

  const captureCpuProfile = Effect.fn("ProcessProfiler.captureCpuProfile")(function* (
    path: string,
    inspector: ProcessInspector,
    durationMillis: number,
  ) {
    yield* inspector.startCpuProfile;
    yield* Effect.sleep(durationMillis);
    const profile = yield* inspector.stopCpuProfile;
    const contents = yield* encodeJson(profile).pipe(Effect.mapError(profileError("encode CPU profile")));
    yield* platform.writeFile(path, contents);
    return path;
  });

  const capture = Effect.fn("ProcessProfiler.capture")(function* (input: ProcessProfileInput) {
    yield* platform.ensureDirectory(input.directory);
    const timestamp = yield* platform.currentTimeMillis;
    const path = profilePath(platform, input, timestamp);
    const inspector = yield* platform.openInspector;
    return yield* ProcessProfileInput.match(input, {
      HeapSnapshot: () => captureHeapSnapshot(path, inspector),
      CpuProfile: ({ durationMillis }) => captureCpuProfile(path, inspector, durationMillis ?? 30_000),
    });
  });

  return { capture: (input: ProcessProfileInput) => Effect.scoped(capture(input)) };
};

const post = (session: Session, method: "Profiler.enable" | "Profiler.start") =>
  Effect.tryPromise({
    try: () => session.post(method),
    catch: profileError(method),
  }).pipe(Effect.timeout(inspectorCommandTimeout), Effect.catchTag("TimeoutError", profileError(method)));

const liveInspector = (session: Session): ProcessInspector => ({
  takeHeapSnapshot: (write) => {
    const listener = (message: { readonly params: { readonly chunk: string } }) =>
      write(message.params.chunk);
    return Effect.tryPromise({
      try: () => {
        session.on("HeapProfiler.addHeapSnapshotChunk", listener);
        return session
          .post("HeapProfiler.takeHeapSnapshot")
          .finally(() => session.off("HeapProfiler.addHeapSnapshotChunk", listener));
      },
      catch: profileError("HeapProfiler.takeHeapSnapshot"),
    }).pipe(
      Effect.timeout(heapSnapshotTimeout),
      Effect.catchTag("TimeoutError", profileError("HeapProfiler.takeHeapSnapshot")),
    );
  },
  startCpuProfile: post(session, "Profiler.enable").pipe(Effect.andThen(post(session, "Profiler.start"))),
  stopCpuProfile: Effect.tryPromise({
    try: () => session.post("Profiler.stop").then(({ profile }) => profile),
    catch: profileError("Profiler.stop"),
  }).pipe(
    Effect.timeout(inspectorCommandTimeout),
    Effect.catchTag("TimeoutError", profileError("Profiler.stop")),
  ),
});

function acquireInspector() {
  return Effect.acquireRelease(
    Effect.try({
      try: () => {
        const session = new Session();
        session.connect();
        return session;
      },
      catch: profileError("connect inspector"),
    }),
    (session) => Effect.sync(() => session.disconnect()),
  ).pipe(Effect.map(liveInspector));
}

export const makeLiveProcessProfiler = Effect.fn("ProcessProfiler.live")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  return makeProcessProfiler({
    pid: process.pid,
    joinPath: path.join,
    currentTimeMillis: Clock.currentTimeMillis,
    openInspector: acquireInspector(),
    ensureDirectory: (directory) =>
      fs
        .makeDirectory(directory, { recursive: true })
        .pipe(Effect.mapError(profileError("create diagnostics directory"))),
    writeFile: (target, contents) =>
      fs.writeFileString(target, contents).pipe(Effect.mapError(profileError("write profile"))),
    writeChunks: (target, produce) =>
      Effect.acquireUseRelease(
        Effect.try({
          try: () => openSynchronousFileWriter(target),
          catch: profileError("open heap snapshot"),
        }),
        (writer) => {
          const state: { failure: unknown | null } = { failure: null };
          return produce((chunk) => {
            if (state.failure !== null) return;
            try {
              writer.write(chunk);
            } catch (cause) {
              state.failure = cause;
            }
          }).pipe(
            Effect.andThen(
              Effect.suspend(() =>
                state.failure === null
                  ? Effect.void
                  : Effect.fail(profileError("write heap snapshot")(state.failure)),
              ),
            ),
          );
        },
        (writer) =>
          Effect.try({
            try: writer.close,
            catch: profileError("close heap snapshot"),
          }),
      ),
  });
});
