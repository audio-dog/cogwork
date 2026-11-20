import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Command from "effect/cli/Command";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";

import { cli } from "./cli";

NodeRuntime.runMain(
  Command.run(cli, { version: "0.0.1" }).pipe(
    Effect.provide(
      Layer.mergeAll(
        FetchHttpClient.layer,
        NodeServices.layer,
        NodeCrypto.layerSecureRandom,
        NodeCrypto.layerDigest,
      ),
    ),
  ),
);
