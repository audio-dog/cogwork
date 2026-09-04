import { writeCodexHookTrust } from "@cogwork/codex-cli";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

const trust = Effect.fn("trustCodexHooks")(function* (checkoutPath: string, codexHome: string) {
  const path = yield* Path.Path;
  return yield* writeCodexHookTrust(
    path.join(checkoutPath, ".codex", "hooks.json"),
    path.join(codexHome, "config.toml"),
  );
});

const checkoutPath = process.argv[2];
const codexHome = process.argv[3];

NodeRuntime.runMain(
  checkoutPath && codexHome
    ? trust(checkoutPath, codexHome).pipe(
        Effect.tap((entries) =>
          Effect.logInfo(
            entries.length === 0
              ? "No repository Codex Hooks need trust"
              : `Trusted ${entries.length} repository Codex Hook${entries.length === 1 ? "" : "s"}`,
          ),
        ),
        Effect.provide(Layer.merge(NodeFileSystem.layer, Path.layer)),
      )
    : Effect.die("usage: trust-codex-hooks <checkout-path> <codex-home>"),
);
