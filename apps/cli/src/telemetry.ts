import * as NodeSdk from "@effect/opentelemetry/NodeSdk";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

export const telemetryLayer = Effect.gen(function* () {
  const endpoint = yield* Config.option(Config.string("OTEL_EXPORTER_OTLP_ENDPOINT"));
  if (Option.isNone(endpoint)) return NodeSdk.layerEmpty;
  return NodeSdk.layer(() => ({
    resource: { serviceName: "cogwork-daemon" },
    spanProcessor: new BatchSpanProcessor(new OTLPTraceExporter()),
  }));
}).pipe(Layer.unwrap);
