import * as Resource from "@effect/opentelemetry/Resource";
import { NodeHttpServer } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Ref from "effect/Ref";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { telemetryLayer } from "./telemetry";

const requests = Metric.counter("cogwork_telemetry_test_requests_total", {
  description: "Requests emitted by the telemetry integration test.",
});

const configLayer = (env: Readonly<Record<string, string>> = {}) =>
  ConfigProvider.layer(ConfigProvider.fromEnv({ env }));

const collectorEndpoint = (address: HttpServer.Address) =>
  address._tag === "UnixAddress"
    ? Effect.die("collector address unavailable")
    : Effect.succeed(`http://127.0.0.1:${address.port}`);

describe("telemetryLayer", () => {
  it.layer(telemetryLayer.pipe(Layer.provide(configLayer())))((it) => {
    it.effect("stays empty without an endpoint", () =>
      Effect.gen(function* () {
        const resource = yield* Resource.Resource;
        assert.deepEqual(resource.getRawAttributes(), []);
      }),
    );
  });

  it.layer(NodeHttpServer.layerTest)((it) => {
    it.effect("exports traces, metrics, and logs through the configured endpoint", () =>
      Effect.gen(function* () {
        const paths = yield* Ref.make<ReadonlySet<string>>(new Set());
        yield* HttpRouter.add(
          "*",
          "*",
          HttpServerRequest.HttpServerRequest.pipe(
            Effect.flatMap((request) =>
              Ref.update(paths, (seen) => new Set([...seen, request.url])).pipe(
                Effect.map(() => HttpServerResponse.empty({ status: 200 })),
              ),
            ),
          ),
        ).pipe(HttpRouter.serve, Layer.build);
        const server = yield* HttpServer.HttpServer;
        const endpoint = yield* collectorEndpoint(server.address);
        const tracesEndpoint = `${endpoint}/custom/traces`;
        yield* Effect.all([Effect.logInfo("telemetry test"), Metric.update(requests, 1)], {
          discard: true,
        }).pipe(
          Effect.withSpan("telemetry test"),
          Effect.provide(
            telemetryLayer.pipe(
              Layer.provide(
                configLayer({
                  OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
                  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: tracesEndpoint,
                }),
              ),
            ),
          ),
          Effect.scoped,
        );

        assert.deepEqual(yield* Ref.get(paths), new Set(["/custom/traces", "/v1/metrics", "/v1/logs"]));
      }),
    );
  });
});
