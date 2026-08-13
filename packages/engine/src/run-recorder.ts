import type { AgUiEvent, RunId, RunRecord } from "@clanker-forge/contracts";
import { agUiDisplayName, agUiSessionId } from "@clanker-forge/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { activityOf, DaemonEventBus } from "./daemon-event-bus";
import { RunLedger } from "./run-ledger";

// The harness hands back a session handle as untrusted output, and it is later echoed verbatim into a
// fenced shell block in the human handoff comment. Whitespace or a backtick would break out of that
// fence, so a handle carrying either is refused rather than stored.
const cleanHandle = (raw: string | null) => (raw && !/[\s`]/.test(raw) ? raw : null);

const encodeJson = Schema.encodeEffect(Schema.UnknownFromJsonString);

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
    const atMillis = yield* Clock.currentTimeMillis;
    const previous = yield* trackOf(run.id);
    const seq = previous.seq;
    const handle = yield* captureHandle(run, previous, event);
    yield* putTrack(run.id, { seq: seq + 1, handle });
    const data = yield* encodeJson(event).pipe(Effect.orElseSucceed(() => "{}"));
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

  return { record } as const;
});

export class RunRecorder extends Context.Service<RunRecorder, Effect.Success<typeof make>>()(
  "@clanker-forge/engine/run-recorder/RunRecorder",
) {}

export const layer = Layer.effect(RunRecorder, make);
