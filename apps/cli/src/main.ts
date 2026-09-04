import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Command from "effect/unstable/cli/Command";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { cli } from "./cli";

NodeRuntime.runMain(
  Command.run(cli, { version: "0.0.1" }).pipe(
    Effect.provide(Layer.mergeAll(FetchHttpClient.layer, NodeServices.layer)),
  ),
);
