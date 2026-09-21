import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestConsole } from "effect/testing";
import * as Command from "effect/unstable/cli/Command";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { cli } from "./cli";

layer(Layer.mergeAll(FetchHttpClient.layer, NodeServices.layer))((it) => {
  it.effect("does not offer BYOK model listing while its Harness is unregistered", () =>
    Effect.gen(function* () {
      yield* Command.runWith(cli, { version: "0.0.1" })(["--help"]);

      assert.notInclude((yield* TestConsole.logLines).join("\n"), "models");
    }),
  );
});
