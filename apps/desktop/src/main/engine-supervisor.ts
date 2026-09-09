import {
  ProcessProfileError,
  type ProcessProfileInput,
  ProcessProfileRequest,
  ProcessProfileRequestId,
  ProcessProfileResponse,
} from "@cogwork/process-diagnostics";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type { EngineStatus } from "../shared/ipc";
import type { EngineCommand } from "./engine-command";

export interface EngineSupervisorOptions {
  readonly command: () => EngineCommand;
  readonly socketPath: string;
  readonly probe: (socketPath: string) => Effect.Effect<boolean>;
  readonly maxRestarts?: number;
  readonly awaitReachable: (socketPath: string) => Effect.Effect<void>;
  readonly terminateTimeout?: Duration.Input;
  readonly forceKillTimeout?: Duration.Input;
  readonly profileCaptureTimeout?: Duration.Input;
}

interface EngineClose {
  readonly code: number | null;
  readonly pid: number;
}

const describeProfileClose = (closed: EngineClose) =>
  `Engine closed during profile capture (code ${closed.code ?? "none"})`;

interface OwnedChild {
  readonly child: ChildProcessSpawner.ChildProcessHandle;
  readonly closed: Deferred.Deferred<EngineClose>;
  readonly outputFibers: ReadonlyArray<Fiber.Fiber<void>>;
  readonly profileRequests: Queue.Queue<Uint8Array>;
  readonly profileRequestTransportClosed: Deferred.Deferred<void>;
  readonly profileResponses: Queue.Queue<ProcessProfileResponse>;
  readonly profileTransportClosed: Deferred.Deferred<void>;
}

export interface EngineSupervisorService {
  readonly status: SubscriptionRef.SubscriptionRef<EngineStatus>;
  readonly start: Effect.Effect<void>;
  readonly stop: Effect.Effect<void>;
  readonly captureProfile: (input: ProcessProfileInput) => Effect.Effect<string, ProcessProfileError>;
}

export class EngineSupervisor extends Context.Service<EngineSupervisor, EngineSupervisorService>()(
  "@cogwork/desktop/main/engine-supervisor",
) {}

const defaultTerminateTimeout = "5 seconds";
const defaultForceKillTimeout = "5 seconds";
const maxOutputLineLength = 16_384;
const outputDrainTimeout = "250 millis";
const profileCaptureTimeout = "2 minutes";
const profileRequestFd = 3;
const profileResponseFd = 4;
const decodeProfileResponse = Schema.decodeUnknownOption(ProcessProfileResponse);

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

interface ProfileLineState {
  readonly buffer: string;
  readonly dropping: boolean;
}

interface OversizedProfileFrame {
  readonly _tag: "OversizedProfileFrame";
}

type ProfileFrame = ProcessProfileResponse | OversizedProfileFrame;

const emptyProfileLine: ProfileLineState = { buffer: "", dropping: false };
const oversizedProfileFrame: OversizedProfileFrame = { _tag: "OversizedProfileFrame" };

const appendProfileSegment = (state: ProfileLineState, segment: string): ProfileLineState => {
  if (state.dropping) return state;
  if (state.buffer.length + segment.length > maxOutputLineLength) return { buffer: "", dropping: true };
  return { buffer: `${state.buffer}${segment}`, dropping: false };
};

const decodeProfileChunk = (state: ProfileLineState, text: string) => {
  const segments = text.split("\n");
  const pending = segments.at(-1) ?? "";
  const complete = segments.slice(0, -1);
  const [next, responses] = complete.reduce(
    ([current, output], segment) => {
      const line = appendProfileSegment(current, segment);
      const response = line.dropping
        ? Option.some<ProfileFrame>(oversizedProfileFrame)
        : decodeProfileResponse(parseJson(line.buffer.replace(/\r$/, "")));
      return [emptyProfileLine, Option.isSome(response) ? [...output, response.value] : output] as const;
    },
    [state, []] as readonly [ProfileLineState, ReadonlyArray<ProfileFrame>],
  );
  return [appendProfileSegment(next, pending), responses] as const;
};

const profileResponseEffect = (
  response: ProcessProfileResponse,
): Effect.Effect<string, ProcessProfileError> =>
  ProcessProfileResponse.match(response, {
    ProcessProfileCompleted: ({ path }): Effect.Effect<string, ProcessProfileError> => Effect.succeed(path),
    ProcessProfileFailed: ({ message }): Effect.Effect<string, ProcessProfileError> =>
      Effect.fail(ProcessProfileError.make({ operation: "capture daemon profile", cause: message })),
  });

const isActiveStatus = (status: EngineStatus) =>
  status === "starting" || status === "running" || status === "adopted";

const setStatus = (status: SubscriptionRef.SubscriptionRef<EngineStatus>, next: EngineStatus) =>
  SubscriptionRef.modifySome(status, (current) => [
    undefined,
    current === next ? Option.none() : Option.some(next),
  ]);

const logExpectedClose = (closed: EngineClose) => Effect.logInfo("Engine closed", { code: closed.code });

const attemptChildClose = (
  owned: OwnedChild,
  terminateTimeout: Duration.Input,
  forceKillTimeout: Duration.Input,
) => {
  const closeTimeout = Duration.sum(
    Duration.fromInputUnsafe(terminateTimeout),
    Duration.fromInputUnsafe(forceKillTimeout),
  );
  return owned.child.kill({ killSignal: "SIGTERM", forceKillAfter: terminateTimeout }).pipe(
    Effect.andThen(Deferred.await(owned.closed)),
    Effect.timeoutOption(closeTimeout),
    Effect.catchCause((cause) =>
      Effect.logWarning("Engine shutdown failed", { cause }).pipe(
        Effect.map(() => Option.none<EngineClose>()),
      ),
    ),
  );
};

const releaseChild = (
  owned: OwnedChild,
  terminateTimeout: Duration.Input,
  forceKillTimeout: Duration.Input,
) =>
  Effect.gen(function* () {
    if (yield* Deferred.isDone(owned.closed)) return;
    yield* Effect.logInfo("Stopping the supervised engine");
    const killed = yield* attemptChildClose(owned, terminateTimeout, forceKillTimeout);
    if (Option.isSome(killed)) return yield* logExpectedClose(killed.value);
    yield* owned.child.unref;
    yield* Effect.logWarning("Engine did not close during shutdown", { code: null });
  }).pipe(
    Effect.annotateLogs({ pid: owned.child.pid }),
    Effect.ensuring(drainOutput(owned.outputFibers)),
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

const pipeOutput = (output: Stream.Stream<Uint8Array, unknown>, stream: "stdout" | "stderr") =>
  output.pipe(
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

const collectProfileResponses = (
  output: Stream.Stream<Uint8Array, unknown>,
  responses: Queue.Queue<ProcessProfileResponse>,
  closed: Deferred.Deferred<void>,
) =>
  output.pipe(
    Stream.decodeText(),
    Stream.mapAccum(() => emptyProfileLine, decodeProfileChunk),
    Stream.runForEach((frame) => {
      if (frame._tag === "OversizedProfileFrame") return Deferred.succeed(closed, undefined);
      return Queue.offer(responses, frame);
    }),
    Effect.catch((error) => Effect.logWarning("Engine profile response stream failed", { error })),
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause),
      (cause) => Effect.logError("Engine profile response stream crashed", { cause }),
    ),
    Effect.ensuring(Deferred.succeed(closed, undefined)),
  );

const sendProfileRequests = (
  requests: Queue.Queue<Uint8Array>,
  input: Sink.Sink<void, Uint8Array, never, unknown>,
  closed: Deferred.Deferred<void>,
) =>
  Stream.fromQueue(requests).pipe(
    Stream.run(input),
    Effect.catch((error) => Effect.logWarning("Engine profile request stream failed", { error })),
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause),
      (cause) => Effect.logError("Engine profile request stream crashed", { cause }),
    ),
    Effect.ensuring(Deferred.succeed(closed, undefined)),
  );

const spawnEngine = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  command: EngineCommand,
  terminateTimeout: Duration.Input,
) =>
  spawner.spawn(
    ChildProcess.make(command.command, command.args, {
      cwd: command.cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      additionalFds: {
        fd3: { type: "input" },
        fd4: { type: "output" },
      },
      env: { COGWORK_PROFILE_FD_TRANSPORT: "1" },
      extendEnv: true,
      forceKillAfter: terminateTimeout,
    }),
  );

const acquireChild = (
  options: EngineSupervisorOptions,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  launched: Deferred.Deferred<void>,
  terminateTimeout: Duration.Input,
) =>
  Effect.gen(function* () {
    const closed = yield* Deferred.make<EngineClose>();
    const profileRequests = yield* Queue.bounded<Uint8Array>(1);
    const profileRequestTransportClosed = yield* Deferred.make<void>();
    const profileResponses = yield* Queue.sliding<ProcessProfileResponse>(16);
    const profileTransportClosed = yield* Deferred.make<void>();
    const child = yield* spawnEngine(spawner, options.command(), terminateTimeout);
    const annotations = { pid: child.pid };
    yield* child.exitCode.pipe(
      Effect.match({
        onFailure: () => ({ code: null, pid: child.pid }),
        onSuccess: (code) => ({ code, pid: child.pid }),
      }),
      Effect.flatMap((close) => Deferred.succeed(closed, close)),
      Effect.forkScoped,
    );
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
    const requests = yield* sendProfileRequests(
      profileRequests,
      child.getInputFd(profileRequestFd),
      profileRequestTransportClosed,
    ).pipe(Effect.annotateLogs(annotations), Effect.annotateSpans(annotations), Effect.forkScoped);
    const responses = yield* collectProfileResponses(
      child.getOutputFd(profileResponseFd),
      profileResponses,
      profileTransportClosed,
    ).pipe(Effect.annotateLogs(annotations), Effect.annotateSpans(annotations), Effect.forkScoped);
    yield* Deferred.succeed(launched, undefined);
    return {
      child,
      closed,
      outputFibers: [stdout, stderr, requests, responses],
      profileRequests,
      profileRequestTransportClosed,
      profileResponses,
      profileTransportClosed,
    };
  });

const drainOutput = (fibers: ReadonlyArray<Fiber.Fiber<void>>) =>
  Effect.all(fibers.map(Fiber.join), { concurrency: "unbounded", discard: true }).pipe(
    Effect.timeoutOption(outputDrainTimeout),
    Effect.asVoid,
  );

function captureChildProfile(
  activeChild: Ref.Ref<OwnedChild | null>,
  profileRequestCounter: Ref.Ref<number>,
) {
  return Effect.fn("EngineSupervisor.captureProfile")(function* (input: ProcessProfileInput) {
    const owned = yield* Ref.get(activeChild);
    if (!owned) {
      return yield* ProcessProfileError.make({
        operation: "capture daemon profile",
        cause: "The daemon is not owned by this supervisor",
      });
    }
    const sequence = yield* Ref.getAndUpdate(profileRequestCounter, (value) => value + 1);
    const request = ProcessProfileRequest.make({
      requestId: ProcessProfileRequestId.make(`${owned.child.pid}:${sequence}`),
      input,
    });
    return yield* Effect.raceFirst(
      Queue.offer(owned.profileRequests, new TextEncoder().encode(`${JSON.stringify(request)}\n`)).pipe(
        Effect.andThen(
          Effect.raceFirst(
            Stream.fromQueue(owned.profileResponses).pipe(
              Stream.filter((candidate) => candidate.requestId === request.requestId),
              Stream.take(1),
              Stream.runHead,
              Effect.flatMap((result) => {
                if (Option.isSome(result)) return profileResponseEffect(result.value);
                return Effect.fail(
                  ProcessProfileError.make({
                    operation: "capture daemon profile",
                    cause: "Profile response stream closed",
                  }),
                );
              }),
            ),
            Effect.raceFirst(
              Deferred.await(owned.closed).pipe(
                Effect.flatMap((closed) =>
                  ProcessProfileError.make({
                    operation: "capture daemon profile",
                    cause: describeProfileClose(closed),
                  }),
                ),
              ),
              Deferred.await(owned.profileTransportClosed).pipe(
                Effect.flatMap(() =>
                  ProcessProfileError.make({
                    operation: "capture daemon profile",
                    cause: "Profile response stream closed",
                  }),
                ),
              ),
            ),
          ),
        ),
      ),
      Deferred.await(owned.profileRequestTransportClosed).pipe(
        Effect.flatMap(() =>
          ProcessProfileError.make({
            operation: "send daemon profile request",
            cause: "Profile request stream closed",
          }),
        ),
      ),
    );
  });
}

export function make(options: EngineSupervisorOptions) {
  return Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const ownerScope = yield* Effect.scope;
    const status = yield* SubscriptionRef.make<EngineStatus>("stopped");
    const activeScope = yield* Ref.make<Scope.Closeable | null>(null);
    const activeChild = yield* Ref.make<OwnedChild | null>(null);
    const profileRequestCounter = yield* Ref.make(0);
    const profileCapture = Semaphore.makeUnsafe(1);
    const lifecycle = Semaphore.makeUnsafe(1);
    const restartBudget = options.maxRestarts ?? 3;
    const restartSchedule = Schedule.recurs(restartBudget);
    const terminateTimeout = options.terminateTimeout ?? defaultTerminateTimeout;
    const forceKillTimeout = options.forceKillTimeout ?? defaultForceKillTimeout;
    const captureTimeout = options.profileCaptureTimeout ?? profileCaptureTimeout;

    const runChild = Effect.fn("EngineSupervisor.runChild")(function* (launched: Deferred.Deferred<void>) {
      yield* setStatus(status, "starting");
      const owned = yield* Effect.acquireRelease(
        acquireChild(options, spawner, launched, terminateTimeout),
        (child) => releaseChild(child, terminateTimeout, forceKillTimeout),
      );
      yield* Ref.set(activeChild, owned);
      yield* Effect.addFinalizer(() =>
        Ref.update(activeChild, (current) => (current === owned ? null : current)),
      );
      const pid = owned.child.pid;
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
        profileCapture.withPermits(1)(
          captureChildProfile(
            activeChild,
            profileRequestCounter,
          )(input).pipe(
            Effect.timeout(captureTimeout),
            Effect.catchTag("TimeoutError", (cause) =>
              ProcessProfileError.make({ operation: "capture daemon profile", cause }),
            ),
          ),
        ),
    };
  });
}

export const layer = (options: EngineSupervisorOptions) => Layer.effect(EngineSupervisor, make(options));
