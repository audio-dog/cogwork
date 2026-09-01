import * as NodeSdk from "@effect/opentelemetry/NodeSdk";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

const signalEndpoint = (
  endpoint: string,
  signal: "traces" | "metrics" | "logs",
  configuredEndpoint: Option.Option<string>,
) =>
  Option.getOrElse(configuredEndpoint, () =>
    new URL(`v1/${signal}`, endpoint.endsWith("/") ? endpoint : `${endpoint}/`).toString(),
  );

export const telemetryLayer = Effect.gen(function* () {
  const endpoint = yield* Config.option(Config.string("OTEL_EXPORTER_OTLP_ENDPOINT"));
  if (Option.isNone(endpoint)) return NodeSdk.layerEmpty;
  const configuredEndpoints = yield* Config.all({
    traces: Config.option(Config.string("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")),
    metrics: Config.option(Config.string("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT")),
    logs: Config.option(Config.string("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT")),
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
