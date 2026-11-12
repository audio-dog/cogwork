import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as MutableRef from "effect/MutableRef";
import * as References from "effect/References";

export interface CapturedLog {
  readonly annotations: Record<string, unknown>;
  readonly message: unknown;
}

interface LogProbeService {
  readonly capture: (entry: CapturedLog) => void;
  readonly entries: Effect.Effect<ReadonlyArray<CapturedLog>>;
}

export class LogProbe extends Context.Service<LogProbe, LogProbeService>()(
  "@cogwork/engine/testing/log-probe/LogProbe",
) {
  static readonly layer = Layer.sync(LogProbe, () => {
    const entries = MutableRef.make<ReadonlyArray<CapturedLog>>([]);
    return {
      capture: (entry) => MutableRef.update(entries, (current) => [...current, entry]),
      entries: Effect.sync(() => MutableRef.get(entries)),
    };
  });
  static readonly captureLayer = Logger.layer([
    Effect.map(LogProbe, (probe) =>
      Logger.make<unknown, void>(({ fiber, message }) =>
        probe.capture({ message, annotations: { ...fiber.getRef(References.CurrentLogAnnotations) } }),
      ),
    ),
  ]).pipe(Layer.provideMerge(LogProbe.layer));
}
