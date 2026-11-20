import type { RunActivity, RunEvent, RunId, SessionId } from "@cogwork/contracts";
import { AgUiEvent, agUiIsSessionHandleEvent, type RunRecord } from "@cogwork/contracts";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { activityOf, DaemonEventBus } from "./daemon-event-bus";
import { decodeStoredRunEvent, encodeStoredRunEvent } from "./run-event-codec";
import { encodeRunEventOperation, RunLedger, RunLedgerError } from "./run-ledger";

// The harness hands back a session handle as untrusted output, and it is later echoed verbatim into a
// fenced shell block in the human handoff comment. Whitespace or a backtick would break out of that
// fence, so a handle carrying either is refused rather than stored.
const cleanHandle = (raw: string | null) => (raw && !/[\s`]/.test(raw) ? raw : null);

const optionalString = (value: unknown) => (typeof value === "string" ? value : null);

const sessionHandle = (event: AgUiEvent) => (agUiIsSessionHandleEvent(event) ? event.value.sessionId : null);

const displayName = (event: AgUiEvent) =>
  AgUiEvent.matchOrElse(
    event,
    {
      TOOL_CALL_START: ({ toolCallName }) => toolCallName ?? null,
      CUSTOM: ({ name }) => name ?? null,
      STEP_STARTED: ({ stepName }) => stepName ?? null,
      STEP_FINISHED: ({ stepName }) => stepName ?? null,
    },
    () => optionalString(event.toolCallName) ?? optionalString(event.name) ?? optionalString(event.stepName),
  );

interface RunTrack {
  readonly seq: number;
  readonly handle: string | null;
}

const emptyTrack: RunTrack = { seq: 0, handle: null };

export const make = Effect.gen(function* () {
  const ledger = yield* RunLedger;
  const bus = yield* DaemonEventBus;
  const tracks = yield* Ref.make<ReadonlyMap<string, RunTrack>>(new Map());

  const trackOf = (runId: RunId) => Effect.map(Ref.get(tracks), (map) => map.get(runId) ?? emptyTrack);

  const putTrack = (runId: RunId, track: RunTrack) =>
    Ref.update(tracks, (map) => new Map(map).set(runId, track));

  const captureHandle = Effect.fn("RunRecorder.captureHandle")(function* (
    run: RunRecord,
    track: RunTrack,
    event: AgUiEvent,
  ) {
    const handle = cleanHandle(sessionHandle(event));
    if (handle === null || handle === track.handle || run.session === null) return track.handle;
    yield* ledger.recordSessionHandle(run.session, handle);
    return handle;
  });

  const record = Effect.fn("RunRecorder.record")(function* (run: RunRecord, event: AgUiEvent) {
    const name = displayName(event);
    const data = yield* encodeStoredRunEvent(event).pipe(
      Effect.mapError((error) =>
        RunLedgerError.make({
          operation: encodeRunEventOperation,
          message: String(error),
          retryable: false,
        }),
      ),
      Effect.tapError((error) =>
        Effect.logError("run event encoding failed", { type: event.type, name, error }),
      ),
    );
    const atMillis = yield* Clock.currentTimeMillis;
    const previous = yield* trackOf(run.id);
    const seq = previous.seq;
    const handle = yield* captureHandle(run, previous, event);
    yield* putTrack(run.id, { seq: seq + 1, handle });
    yield* ledger.appendEvent(run.id, {
      seq,
      type: event.type,
      name,
      data,
      atMillis,
    });
    yield* decodeStoredRunEvent(data).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          Effect.logError("run event withheld from the event bus", { type: event.type, name, error }),
        onSuccess: (stored) => bus.publishActivity(activityOf(run, seq, atMillis, stored)),
      }),
    );
    return handle;
  });

  const decodeReplayPage = (run: RunRecord, events: ReadonlyArray<RunEvent>) =>
    Effect.forEach(events, (event) =>
      decodeStoredRunEvent(event.data).pipe(
        Effect.map((decoded) => activityOf(run, event.seq, event.atMillis, decoded)),
        Effect.option,
      ),
    ).pipe(
      Effect.map(
        (decoded) =>
          [undefined, Arr.getSomes(decoded)] satisfies readonly [undefined, ReadonlyArray<RunActivity>],
      ),
    );

  const replay = (run: RunRecord) =>
    ledger.events(run.id).pipe(
      Stream.mapAccumArrayEffect(
        () => undefined,
        (_, events) => decodeReplayPage(run, events),
      ),
    );

  // The decoded harness events a session's transcript fold consumes — every run that shares the
  // session, oldest first — so the session store never decodes a run event itself.
  const sessionEvents = Effect.fn("RunRecorder.sessionEvents")(function* (session: SessionId) {
    const events = yield* ledger.sessionEvents(session);
    return yield* Effect.forEach(events, (event) =>
      decodeStoredRunEvent(event.data).pipe(Effect.option),
    ).pipe(Effect.map(Arr.getSomes));
  });

  return { record, replay, sessionEvents } as const;
});

export type RunRecorderService = Effect.Success<typeof make>;

export class RunRecorder extends Context.Service<RunRecorder, RunRecorderService>()(
  "@cogwork/engine/run-recorder/RunRecorder",
) {}

export const layer = Layer.effect(RunRecorder, make);
