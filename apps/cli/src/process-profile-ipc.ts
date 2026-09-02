import {
  makeLiveProcessProfiler,
  ProcessProfileError,
  ProcessProfileRequest,
  ProcessProfileResponse,
  type ProcessProfileResponse as ProcessProfileResponseValue,
} from "@cogwork/process-diagnostics";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeRequest = Schema.decodeUnknownOption(ProcessProfileRequest);
const daemonProfileTimeout = "110 seconds";
const processSendTimeout = "5 seconds";

const sendResponse = (response: ProcessProfileResponseValue) =>
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

export const installProcessProfileIpc = Effect.fn("ProcessProfileIpc.install")(function* () {
  if (!process.send) return;
  const profiler = yield* makeLiveProcessProfiler();
  const runPromise = yield* FiberSet.makeRuntimePromise();
  const onMessage = (message: unknown) =>
    runPromise(
      respondToProfileRequest(profiler, message).pipe(
        Effect.catch((error) => Effect.logError("Process profile request failed", { error })),
      ),
    );
  yield* Effect.acquireRelease(
    Effect.sync(() => process.on("message", onMessage)),
    () => Effect.sync(() => process.off("message", onMessage)),
  );
});
