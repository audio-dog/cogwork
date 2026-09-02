import {
  ProcessProfileError,
  type ProcessProfileInput,
  ProcessProfileRequest,
  ProcessProfileRequestId,
  ProcessProfileResponse,
} from "@cogwork/process-diagnostics";
import { NodeStream } from "@effect/platform-node";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { EngineStatus } from "../shared/ipc";
import type { EngineCommand } from "./engine-command";

export interface EngineChild {
  readonly pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "message", listener: (message: unknown) => void): unknown;
  off(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  off(event: "message", listener: (message: unknown) => void): unknown;
  send(message: unknown, callback?: (error: Error | null) => void): boolean;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
}

export type SpawnEngine = (command: EngineCommand) => EngineChild;

export interface EngineSupervisorOptions {
  readonly command: () => EngineCommand;
  readonly socketPath: string;
  readonly spawn: SpawnEngine;
  readonly probe: (socketPath: string) => Effect.Effect<boolean>;
  readonly maxRestarts?: number;
  readonly awaitReachable: (socketPath: string) => Effect.Effect<void>;
  readonly terminateTimeout?: Duration.Input;
  readonly forceKillTimeout?: Duration.Input;
}

interface EngineClose {
  readonly code: number | null;
  readonly pid: number | null;
  readonly signal: NodeJS.Signals | null;
}

interface OwnedChild {
  readonly child: EngineChild;
  readonly closed: Deferred.Deferred<EngineClose>;
  readonly onClose: (code: number | null, signal: NodeJS.Signals | null) => void;
  readonly outputFibers: ReadonlyArray<Fiber.Fiber<void>>;
}

export interface EngineSupervisorService {
  readonly status: SubscriptionRef.SubscriptionRef<EngineStatus>;
  readonly start: Effect.Effect<void>;
  readonly stop: Effect.Effect<void>;
  readonly captureProfile: (input: ProcessProfileInput) => Effect.Effect<string, ProcessProfileError>;
}

const defaultTerminateTimeout = "5 seconds";
const defaultForceKillTimeout = "5 seconds";
const maxOutputLineLength = 16_384;
const outputDrainTimeout = "250 millis";
const profileCaptureTimeout = "2 minutes";
const decodeProfileResponse = Schema.decodeUnknownOption(ProcessProfileResponse);

const isActiveStatus = (status: EngineStatus) =>
  status === "starting" || status === "running" || status === "adopted";

const setStatus = (status: SubscriptionRef.SubscriptionRef<EngineStatus>, next: EngineStatus) =>
  SubscriptionRef.modifySome(status, (current) => [
    undefined,
    current === next ? Option.none() : Option.some(next),
  ]);

const signalChild = (child: EngineChild, signal: NodeJS.Signals) =>
  Effect.try({
    try: () => child.kill(signal),
    catch: (cause) => cause,
  }).pipe(Effect.ignore);

const awaitExitAfter = (owned: OwnedChild, signal: NodeJS.Signals, timeout: Duration.Input) =>
  signalChild(owned.child, signal).pipe(
    Effect.andThen(Deferred.await(owned.closed)),
    Effect.timeoutOption(timeout),
  );

const logExpectedClose = (closed: EngineClose) =>
  Effect.logInfo("Engine closed", { code: closed.code, signal: closed.signal });

const logForcedClose = (closed: EngineClose) =>
  Effect.logWarning("Engine closed after SIGKILL", { code: closed.code, signal: closed.signal });

const releaseChild = (
  owned: OwnedChild,
  terminateTimeout: Duration.Input,
  forceKillTimeout: Duration.Input,
) =>
  Effect.gen(function* () {
    if (yield* Deferred.isDone(owned.closed)) return;
    yield* Effect.logInfo("Stopping the supervised engine");
    const terminated = yield* awaitExitAfter(owned, "SIGTERM", terminateTimeout);
    if (Option.isSome(terminated)) return yield* logExpectedClose(terminated.value);
    yield* Effect.logWarning("Engine ignored SIGTERM; sending SIGKILL");
    const killed = yield* awaitExitAfter(owned, "SIGKILL", forceKillTimeout);
    if (Option.isSome(killed)) return yield* logForcedClose(killed.value);
    yield* Effect.logWarning("Engine did not close after SIGKILL", { code: null, signal: null });
  }).pipe(
    Effect.annotateLogs({ pid: owned.child.pid ?? null }),
    Effect.andThen(drainOutput(owned.outputFibers)),
    Effect.ensuring(Effect.sync(() => owned.child.off("close", owned.onClose))),
    Effect.ignore,
  );

const logOutputLine = (stream: "stdout" | "stderr", line: string) => {
  const fields = { line, stream };
  if (stream === "stdout") return Effect.logInfo("Engine output", fields);
  return Effect.logWarning("Engine output", fields);
};

const boundOutputSegment = (lineLength: number, segment: string) => {
  if (!segment) return [lineLength, []] as const;
  const available = maxOutputLineLength - lineLength;
  if (segment.length <= available) return [lineLength + segment.length, [segment]] as const;
  const remainder = segment.slice(available);
  const remainderCount = Math.ceil(remainder.length / maxOutputLineLength);
  const chunks = Array.from({ length: remainderCount }, (_, index) => {
    const chunk = remainder.slice(index * maxOutputLineLength, (index + 1) * maxOutputLineLength);
    return index < remainderCount - 1 ? `${chunk}\n` : chunk;
  });
  const finalLength = remainder.length % maxOutputLineLength || maxOutputLineLength;
  return [finalLength, [`${segment.slice(0, available)}\n`, ...chunks]] as const;
};

const boundOutputChunk = (lineLength: number, text: string) =>
  text.split(/(\r\n|\r|\n)/).reduce(
    ([currentLength, output], token) => {
      if (/^(\r\n|\r|\n)$/.test(token)) return [0, [...output, token]] as const;
      const [nextLength, chunks] = boundOutputSegment(currentLength, token);
      return [nextLength, [...output, ...chunks]] as const;
    },
    [lineLength, []] as readonly [number, ReadonlyArray<string>],
  );

const setRunning = (status: SubscriptionRef.SubscriptionRef<EngineStatus>) =>
  Effect.logInfo("Engine is listening on the socket").pipe(Effect.andThen(setStatus(status, "running")));

const pipeOutput = (readable: NodeJS.ReadableStream | null, stream: "stdout" | "stderr") => {
  if (!readable) return Effect.void;
  return NodeStream.fromReadable({ evaluate: () => readable }).pipe(
    Stream.decodeText(),
    Stream.mapAccum(() => 0, boundOutputChunk),
    Stream.splitLines,
    Stream.runForEach((line) => logOutputLine(stream, line)),
    Effect.catch((error) => Effect.logWarning("Engine output stream failed", { error, stream })),
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause),
      (cause) => Effect.logError("Engine output stream crashed", { cause, stream }),
    ),
  );
};

const acquireChild = (options: EngineSupervisorOptions, launched: Deferred.Deferred<void>) =>
  Effect.gen(function* () {
    const closed = yield* Deferred.make<EngineClose>();
    const child = yield* Effect.sync(() => options.spawn(options.command()));
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      Deferred.doneUnsafe(closed, Effect.succeed({ code, pid: child.pid ?? null, signal }));
    };
    yield* Effect.sync(() => child.once("close", onClose));
    const annotations = { pid: child.pid ?? null };
    const stdout = yield* pipeOutput(child.stdout, "stdout").pipe(
      Effect.annotateLogs(annotations),
      Effect.annotateSpans(annotations),
      Effect.forkScoped,
    );
    const stderr = yield* pipeOutput(child.stderr, "stderr").pipe(
      Effect.annotateLogs(annotations),
      Effect.annotateSpans(annotations),
      Effect.forkScoped,
    );
    yield* Deferred.succeed(launched, undefined);
    return { child, closed, onClose, outputFibers: [stdout, stderr] };
  });

const drainOutput = (fibers: ReadonlyArray<Fiber.Fiber<void>>) =>
  Effect.all(fibers.map(Fiber.join), { concurrency: "unbounded", discard: true }).pipe(
    Effect.timeoutOption(outputDrainTimeout),
    Effect.asVoid,
  );

const captureChildProfile = Effect.fn("EngineSupervisor.captureProfile")(function* (
  activeChild: Ref.Ref<OwnedChild | null>,
  profileRequestCounter: Ref.Ref<number>,
  input: ProcessProfileInput,
) {
  const owned = yield* Ref.get(activeChild);
  if (!owned) {
    return yield* ProcessProfileError.make({
      operation: "capture daemon profile",
      cause: "The daemon is not owned by this supervisor",
    });
  }
  const sequence = yield* Ref.getAndUpdate(profileRequestCounter, (value) => value + 1);
  const request = ProcessProfileRequest.make({
    requestId: ProcessProfileRequestId.make(`${owned.child.pid ?? "engine"}:${sequence}`),
    input,
  });
  const response = Effect.callback<string, ProcessProfileError>((resume) => {
    const onMessage = (message: unknown) => {
      Option.match(decodeProfileResponse(message), {
        onNone: () => undefined,
        onSome: (decoded) => {
          if (decoded.requestId !== request.requestId) return;
          ProcessProfileResponse.match(decoded, {
            ProcessProfileCompleted: ({ path }) => resume(Effect.succeed(path)),
            ProcessProfileFailed: ({ message }) =>
              resume(
                Effect.fail(
                  ProcessProfileError.make({ operation: "capture daemon profile", cause: message }),
                ),
              ),
          });
        },
      });
    };
    owned.child.on("message", onMessage);
    try {
      owned.child.send(request, (error) => {
        if (!error) return;
        resume(
          Effect.fail(ProcessProfileError.make({ operation: "send daemon profile request", cause: error })),
        );
      });
    } catch (cause) {
      resume(Effect.fail(ProcessProfileError.make({ operation: "send daemon profile request", cause })));
    }
    return Effect.sync(() => owned.child.off("message", onMessage));
  });
  return yield* Effect.raceFirst(
    response,
    Deferred.await(owned.closed).pipe(
      Effect.flatMap((closed) =>
        ProcessProfileError.make({ operation: "capture daemon profile", cause: closed }),
      ),
    ),
  ).pipe(
    Effect.timeout(profileCaptureTimeout),
    Effect.catchTag("TimeoutError", (cause) =>
      ProcessProfileError.make({ operation: "capture daemon profile", cause }),
    ),
  );
});

function make(options: EngineSupervisorOptions) {
  return Effect.gen(function* () {
    const ownerScope = yield* Effect.scope;
    const status = yield* SubscriptionRef.make<EngineStatus>("stopped");
    const activeScope = yield* Ref.make<Scope.Closeable | null>(null);
    const activeChild = yield* Ref.make<OwnedChild | null>(null);
    const profileRequestCounter = yield* Ref.make(0);
    const lifecycle = Semaphore.makeUnsafe(1);
    const restartBudget = options.maxRestarts ?? 3;
    const restartSchedule = Schedule.recurs(restartBudget);
    const terminateTimeout = options.terminateTimeout ?? defaultTerminateTimeout;
    const forceKillTimeout = options.forceKillTimeout ?? defaultForceKillTimeout;

    const runChild = Effect.fn("EngineSupervisor.runChild")(function* (launched: Deferred.Deferred<void>) {
      yield* setStatus(status, "starting");
      const owned = yield* Effect.acquireRelease(acquireChild(options, launched), (child) =>
        releaseChild(child, terminateTimeout, forceKillTimeout),
      );
      yield* Ref.set(activeChild, owned);
      yield* Effect.addFinalizer(() =>
        Ref.update(activeChild, (current) => (current === owned ? null : current)),
      );
      const pid = owned.child.pid ?? null;
      const annotations = { pid };
      yield* Effect.logInfo("Engine started").pipe(
        Effect.annotateLogs(annotations),
        Effect.annotateSpans(annotations),
      );
      const awaitClose = Deferred.await(owned.closed);
      return yield* Effect.raceFirst(
        awaitClose,
        options
          .awaitReachable(options.socketPath)
          .pipe(Effect.andThen(setRunning(status)), Effect.andThen(awaitClose)),
      ).pipe(Effect.annotateLogs(annotations), Effect.annotateSpans(annotations));
    });

    const supervise = Effect.fn("EngineSupervisor.supervise")(function* (launched: Deferred.Deferred<void>) {
      yield* Effect.scoped(runChild(launched)).pipe(
        Effect.tap((exit) =>
          Effect.logWarning("Engine closed unexpectedly", {
            code: exit.code,
            signal: exit.signal,
          }).pipe(Effect.annotateLogs({ pid: exit.pid })),
        ),
        Effect.repeat(restartSchedule),
      );
      yield* Effect.logWarning("Engine restart budget exhausted", { restarts: restartBudget });
      yield* setStatus(status, "failed");
    });

    const closeActiveScope = Effect.fn("EngineSupervisor.closeActiveScope")(function* () {
      const active = yield* Ref.getAndSet(activeScope, null);
      if (!active) return;
      yield* Scope.close(active, Exit.void);
    });

    const startUnlocked = Effect.fn("EngineSupervisor.start")(function* () {
      const current = yield* SubscriptionRef.get(status);
      if (isActiveStatus(current)) return;
      yield* closeActiveScope();
      if (yield* options.probe(options.socketPath)) {
        yield* Effect.logInfo("Adopted an engine already listening on the socket");
        yield* setStatus(status, "adopted");
        return;
      }
      const launched = yield* Deferred.make<void>();
      const scope = yield* Scope.fork(ownerScope);
      yield* Ref.set(activeScope, scope);
      yield* supervise(launched).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logError("Engine supervisor failed", { cause }).pipe(
              Effect.andThen(setStatus(status, "failed")),
            ),
        ),
        Effect.ensuring(Deferred.succeed(launched, undefined)),
        Effect.forkIn(scope, { startImmediately: true }),
      );
      yield* Deferred.await(launched);
    });

    const stopUnlocked = Effect.fn("EngineSupervisor.stop")(function* () {
      yield* closeActiveScope();
      yield* setStatus(status, "stopped");
    });

    return {
      status,
      start: lifecycle.withPermits(1)(startUnlocked()),
      stop: lifecycle.withPermits(1)(stopUnlocked()),
      captureProfile: (input: ProcessProfileInput) =>
        captureChildProfile(activeChild, profileRequestCounter, input),
    };
  });
}

export class EngineSupervisor extends Context.Service<EngineSupervisor, EngineSupervisorService>()(
  "@cogwork/desktop/engine-supervisor",
) {
  static readonly layer = (options: EngineSupervisorOptions) => Layer.effect(EngineSupervisor, make(options));
}
