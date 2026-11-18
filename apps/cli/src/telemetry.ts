import * as NodeSdk from "@effect/opentelemetry/NodeSdk";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { defaultTelemetryStorePath } from "./paths";
import { localTelemetryLayer } from "./telemetry-store";

interface TelemetryOptions {
  readonly enabled?: boolean;
  readonly storePath?: string;
  readonly snapshotInterval?: Duration.Input;
  readonly maintenanceInterval?: Duration.Input;
  readonly retention?: Duration.Input;
  readonly sizeCapBytes?: number;
}

const defaultSnapshotInterval = Duration.seconds(10);
const defaultMaintenanceInterval = Duration.minutes(1);
const defaultRetention = Duration.days(7);
const defaultSizeCapBytes = 256 * 1024 * 1024;

const signalEndpoint = (
  endpoint: string,
  signal: "traces" | "metrics" | "logs",
  configuredEndpoint: Option.Option<string>,
) =>
  Option.getOrElse(configuredEndpoint, () =>
    new URL(`v1/${signal}`, endpoint.endsWith("/") ? endpoint : `${endpoint}/`).toString(),
  );

function otlpTelemetryLayer() {
  return Effect.gen(function* () {
    const endpoint = yield* Config.option(Config.String("OTEL_EXPORTER_OTLP_ENDPOINT"));
    if (Option.isNone(endpoint)) return NodeSdk.layerEmpty;
    const configuredEndpoints = yield* Config.all({
      traces: Config.option(Config.String("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")),
      metrics: Config.option(Config.String("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT")),
      logs: Config.option(Config.String("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT")),
    });
    return NodeSdk.layer(() => ({
      resource: { serviceName: "cogwork-daemon" },
      spanProcessor: new BatchSpanProcessor(
        new OTLPTraceExporter({
          url: signalEndpoint(endpoint.value, "traces", configuredEndpoints.traces),
        }),
      ),
      metricReader: new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
          url: signalEndpoint(endpoint.value, "metrics", configuredEndpoints.metrics),
        }),
      }),
      logRecordProcessor: new BatchLogRecordProcessor({
        exporter: new OTLPLogExporter({
          url: signalEndpoint(endpoint.value, "logs", configuredEndpoints.logs),
        }),
      }),
    }));
  }).pipe(Layer.unwrap);
}

export const telemetryLayer = (options: TelemetryOptions = {}) => {
  if (options.enabled === false) return NodeSdk.layerEmpty;
  return localTelemetryLayer({
    storePath: options.storePath ?? defaultTelemetryStorePath,
    snapshotInterval: options.snapshotInterval ?? defaultSnapshotInterval,
    maintenanceInterval: options.maintenanceInterval ?? defaultMaintenanceInterval,
    retention: options.retention ?? defaultRetention,
    sizeCapBytes: options.sizeCapBytes ?? defaultSizeCapBytes,
  }).pipe(Layer.provideMerge(otlpTelemetryLayer()));
};
