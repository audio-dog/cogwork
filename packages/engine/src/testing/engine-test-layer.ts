import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as DaemonEventBus from "../daemon-event-bus";
import { layer as githubClientLayer } from "../github/client";
import { HarnessReadinessCache } from "../harness-readiness";
import * as RunLedger from "../run-ledger";
import { layer as runRecorderLayer } from "../run-recorder";
import * as SessionStore from "../session-store";

type RunLedgerLayer = Layer.Layer<RunLedger.RunLedger>;

export interface EngineTestLayerOptions {
  readonly coreRunLedger?: Layer.Layer<RunLedger.CoreRunLedger>;
  readonly transformRunLedger?: (layer: RunLedgerLayer) => RunLedgerLayer;
}

const keepRunLedger = (layer: RunLedgerLayer) => layer;

export const engineTestLayer = ({
  coreRunLedger = RunLedger.layerMemoryCore,
  transformRunLedger = keepRunLedger,
}: EngineTestLayerOptions = {}) => {
  const daemonEventBus = DaemonEventBus.layer;
  const runLedger = transformRunLedger(
    RunLedger.publishingLayer.pipe(Layer.provide(coreRunLedger), Layer.provide(daemonEventBus)),
  );
  const runRecorder = runRecorderLayer.pipe(Layer.provide(runLedger), Layer.provide(daemonEventBus));
  const sessionStore = SessionStore.layer.pipe(Layer.provide(runLedger), Layer.provide(runRecorder));
  return Layer.mergeAll(
    Layer.mock(HarnessReadinessCache, {
      readiness: () => Effect.succeed({ harnesses: [], checkedAtMillis: 0 }),
      requestAll: () => Effect.void,
      requestOne: () => Effect.void,
    }),
    daemonEventBus,
    runLedger,
    runRecorder,
    sessionStore,
    githubClientLayer.pipe(
      Layer.provide(
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("Unexpected GitHub request")),
        ),
      ),
    ),
    Path.layer,
  );
};
