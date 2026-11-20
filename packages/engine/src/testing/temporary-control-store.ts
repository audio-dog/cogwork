import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { bootControlStoreLayer } from "../control-store";

export const temporaryControlStoreLayer = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-control-store-" });
    return bootControlStoreLayer(path.join(directory, "control.db"));
  }),
).pipe(Layer.provide(NodeServices.layer));
