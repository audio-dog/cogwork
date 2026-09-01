import type { RunId, SessionId } from "@cogwork/contracts";
import { AgUiEvent, agUiDisplayName, agUiSessionId, type RunRecord } from "@cogwork/contracts";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { activityOf, DaemonEventBus } from "./daemon-event-bus";
import { RunLedger, RunLedgerError } from "./run-ledger";

// The harness hands back a session handle as untrusted output, and it is later echoed verbatim into a
// fenced shell block in the human handoff comment. Whitespace or a backtick would break out of that
// fence, so a handle carrying either is refused rather than stored.
const cleanHandle = (raw: string | null) => (raw && !/[\s`]/.test(raw) ? raw : null);

// The encode/decode between a harness event and a run event's stored payload is the recorder's
// private detail. Nothing outside this module touches it, so live and replayed activity can only
// ever agree.
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(AgUiEvent));

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
    const handle = cleanHandle(agUiSessionId(event));
    if (handle === null || handle === track.handle || run.session === null) return track.handle;
    yield* ledger.recordSessionHandle(run.session, handle);
    return handle;
  });

  const record = Effect.fn("RunRecorder.record")(function* (run: RunRecord, event: AgUiEvent) {
    const data = yield* encodeJson(event).pipe(
      Effect.mapError((error) =>
        RunLedgerError.make({
          operation: "encode run event",
          message: String(error),
          retryable: false,
        }),
      ),
      Effect.tapError((error) => Effect.logError("run event encoding failed", { type: event.type, error })),
    );
    const atMillis = yield* Clock.currentTimeMillis;
    const previous = yield* trackOf(run.id);
    const seq = previous.seq;
    const handle = yield* captureHandle(run, previous, event);
    yield* putTrack(run.id, { seq: seq + 1, handle });
    yield* ledger.appendEvent(run.id, {
      seq,
      type: event.type,
      name: agUiDisplayName(event),
      data,
      atMillis,
    });
    yield* bus.publishActivity(activityOf(run, seq, atMillis, event));
    return handle;
  });

  // A settled run reads back through the same seam it was written through: decode each stored run
  // event and lift it into the very same run activity a live subscriber saw, dropping any event that
  // will not decode (a forward-compat guard, same as the live path).
  const replay = Effect.fn("RunRecorder.replay")(function* (run: RunRecord) {
    const events = yield* ledger.events(run.id);
    return yield* Effect.forEach(events, (event) =>
      decodeEvent(event.data).pipe(
        Effect.map((decoded) => activityOf(run, event.seq, event.atMillis, decoded)),
        Effect.option,
      ),
    ).pipe(Effect.map(Arr.getSomes));
  });

  // The decoded harness events a session's transcript fold consumes — every run that shares the
  // session, oldest first — so the session store never decodes a run event itself.
  const sessionEvents = Effect.fn("RunRecorder.sessionEvents")(function* (session: SessionId) {
    const events = yield* ledger.sessionEvents(session);
    return yield* Effect.forEach(events, (event) => decodeEvent(event.data).pipe(Effect.option)).pipe(
      Effect.map(Arr.getSomes),
    );
  });

  return { record, replay, sessionEvents } as const;
});

export type RunRecorderService = Effect.Success<typeof make>;

export class RunRecorder extends Context.Service<RunRecorder, RunRecorderService>()(
  "@cogwork/engine/run-recorder/RunRecorder",
) {}

export const layer = Layer.effect(RunRecorder, make);
