import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as DaemonEventBus from "../daemon-event-bus";
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
  return Layer.mergeAll(daemonEventBus, runLedger, runRecorder, sessionStore, Path.layer);
};
