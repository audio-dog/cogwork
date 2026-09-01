import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Command from "effect/unstable/cli/Command";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { cli } from "./cli";
import { defaultEnvFilePath } from "./paths";

NodeRuntime.runMain(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (yield* fs.exists(defaultEnvFilePath))
      yield* Effect.sync(() => process.loadEnvFile(defaultEnvFilePath));
  }).pipe(
    Effect.andThen(Command.run(cli, { version: "0.0.1" })),
    Effect.provide(Layer.mergeAll(FetchHttpClient.layer, NodeServices.layer)),
  ),
);
