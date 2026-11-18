import {
  makeLiveProcessProfiler,
  ProcessProfileError,
  ProcessProfileRequest,
  ProcessProfileResponse,
  type ProcessProfileResponse as ProcessProfileResponseValue,
} from "@cogwork/process-diagnostics";
import { NodeSink, NodeStream } from "@effect/platform-node";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { profileFdStreams } from "./profile-fd-streams";

const decodeRequest = Schema.decodeUnknownOption(ProcessProfileRequest);
const daemonProfileTimeout = "110 seconds";
const maxProfileRequestLineLength = 16_384;
const processSendTimeout = "5 seconds";

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

interface ProfileRequestLineState {
  readonly buffer: string;
  readonly dropping: boolean;
}

const emptyProfileRequestLine: ProfileRequestLineState = { buffer: "", dropping: false };

const appendProfileRequestSegment = (state: ProfileRequestLineState, segment: string) => {
  if (state.dropping) return state;
  if (state.buffer.length + segment.length > maxProfileRequestLineLength) {
    return { buffer: "", dropping: true };
  }
  return { buffer: `${state.buffer}${segment}`, dropping: false };
};

const decodeProfileRequestChunk = (state: ProfileRequestLineState, text: string) => {
  const segments = text.split("\n");
  const pending = segments.at(-1) ?? "";
  const complete = segments.slice(0, -1);
  const [next, requests] = complete.reduce(
    ([current, output], segment) => {
      const line = appendProfileRequestSegment(current, segment);
      if (line.dropping) return [emptyProfileRequestLine, output] as const;
      const request = decodeRequest(parseJson(line.buffer.replace(/\r$/, "")));
      return [emptyProfileRequestLine, Option.isSome(request) ? [...output, request.value] : output] as const;
    },
    [state, []] as readonly [ProfileRequestLineState, ReadonlyArray<ProcessProfileRequest>],
  );
  return [appendProfileRequestSegment(next, pending), requests] as const;
};

const sendProcessResponse = (response: ProcessProfileResponseValue) =>
  Effect.callback<void, ProcessProfileError>((resume) => {
    if (!process.send) {
      resume(
        Effect.fail(
          ProcessProfileError.make({
            operation: "send process profile response",
            cause: "Process channel is unavailable",
          }),
        ),
      );
      return;
    }
    try {
      process.send(response, (error) => {
        if (!error) {
          resume(Effect.void);
          return;
        }
        resume(
          Effect.fail(ProcessProfileError.make({ operation: "send process profile response", cause: error })),
        );
      });
    } catch (cause) {
      resume(Effect.fail(ProcessProfileError.make({ operation: "send process profile response", cause })));
    }
  }).pipe(
    Effect.timeout(processSendTimeout),
    Effect.catchTag("TimeoutError", (cause) =>
      ProcessProfileError.make({ operation: "send process profile response", cause }),
    ),
  );

const respondToProfileRequest = Effect.fn("ProcessProfileIpc.respond")(function* (
  profiler: Effect.Success<ReturnType<typeof makeLiveProcessProfiler>>,
  message: unknown,
  sendResponse: (response: ProcessProfileResponseValue) => Effect.Effect<void, ProcessProfileError>,
) {
  const request = Option.getOrNull(decodeRequest(message));
  if (!request) return;
  const response = yield* profiler.capture(request.input).pipe(
    Effect.timeout(daemonProfileTimeout),
    Effect.catchTag("TimeoutError", (cause) =>
      ProcessProfileError.make({ operation: "capture daemon profile", cause }),
    ),
    Effect.match({
      onFailure: (error) =>
        ProcessProfileResponse.cases.ProcessProfileFailed.make({
          requestId: request.requestId,
          message: `${error.operation}: ${String(error.cause)}`,
        }),
      onSuccess: (path) =>
        ProcessProfileResponse.cases.ProcessProfileCompleted.make({
          requestId: request.requestId,
          path,
        }),
    }),
  );
  yield* sendResponse(response);
});

const installFdProfileTransport = Effect.fn("ProcessProfileIpc.installFdTransport")(function* () {
  const { requests, responses } = yield* Effect.acquireRelease(
    Effect.try({
      try: profileFdStreams,
      catch: (cause) => ProcessProfileError.make({ operation: "open process profile transport", cause }),
    }),
    ({ requests, responses }) =>
      Effect.sync(() => {
        requests.destroy();
        responses.destroy();
      }),
  );
  const responseSink = NodeSink.fromWritable({
    evaluate: () => responses,
    onError: (cause) => ProcessProfileError.make({ operation: "send process profile response", cause }),
    endOnDone: true,
  });
  const responseQueue = yield* Queue.bounded<Uint8Array>(1);
  const responseTransportClosed = yield* Deferred.make<void>();
  const sendResponse = (response: ProcessProfileResponseValue) =>
    Effect.raceFirst(
      Queue.offer(responseQueue, new TextEncoder().encode(`${JSON.stringify(response)}\n`)).pipe(
        Effect.asVoid,
      ),
      Deferred.await(responseTransportClosed).pipe(
        Effect.flatMap(() =>
          ProcessProfileError.make({
            operation: "send process profile response",
            cause: "Profile response stream closed",
          }),
        ),
      ),
    ).pipe(
      Effect.timeout(processSendTimeout),
      Effect.catchTag("TimeoutError", (cause) =>
        ProcessProfileError.make({ operation: "send process profile response", cause }),
      ),
    );
  yield* Stream.fromQueue(responseQueue).pipe(
    Stream.run(responseSink),
    Effect.catch((error) => Effect.logError("Process profile response stream failed", { error })),
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause),
      (cause) => Effect.logError("Process profile response stream crashed", { cause }),
    ),
    Effect.ensuring(Deferred.succeed(responseTransportClosed, undefined)),
    Effect.forkScoped,
  );
  const profiler = yield* makeLiveProcessProfiler();
  yield* NodeStream.fromReadable({ evaluate: () => requests, closeOnDone: true }).pipe(
    Stream.decodeText(),
    Stream.mapAccum(() => emptyProfileRequestLine, decodeProfileRequestChunk),
    Stream.runForEach((request) =>
      respondToProfileRequest(profiler, request, sendResponse).pipe(
        Effect.catch((error) => Effect.logError("Process profile request failed", { error })),
      ),
    ),
    Effect.catch((error) => Effect.logError("Process profile transport failed", { error })),
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause),
      (cause) => Effect.logError("Process profile transport crashed", { cause }),
    ),
    Effect.forkScoped,
  );
});

const installProcessProfileTransport = Effect.fn("ProcessProfileIpc.installProcessTransport")(function* () {
  const profiler = yield* makeLiveProcessProfiler();
  const runPromise = yield* FiberSet.makeRuntimePromise();
  const onMessage = (message: unknown) =>
    runPromise(
      respondToProfileRequest(profiler, message, sendProcessResponse).pipe(
        Effect.catch((error) => Effect.logError("Process profile request failed", { error })),
      ),
    );
  yield* Effect.acquireRelease(
    Effect.sync(() => process.on("message", onMessage)),
    () => Effect.sync(() => process.off("message", onMessage)),
  );
});

export const installProcessProfileIpc = Effect.fn("ProcessProfileIpc.install")(function* () {
  const fdTransport = yield* Config.String("COGWORK_PROFILE_FD_TRANSPORT").pipe(Config.withDefault("0"));
  if (fdTransport === "1") return yield* installFdProfileTransport();
  if (!process.send) return;
  yield* installProcessProfileTransport();
});
