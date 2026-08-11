import { ModelCatalog, Providers } from "@clanker-forge/engine";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { layer as credentialsLayer } from "./credentials";
import { defaultCredentialsPath } from "./paths";

const credentialsFlag = Flag.string("credentials").pipe(
  Flag.withDescription("Path to the stored credential file (0600)"),
  Flag.withDefault(defaultCredentialsPath),
);

const runModels = (options: { readonly credentials: string }) =>
  Effect.gen(function* () {
    const configured = yield* Providers.configuredProviders();
    if (configured.length === 0) {
      yield* Console.log(
        "No providers configured. Store a key with `clanker-forge login key --provider <id>`, or set the provider's API key env var.",
      );
      return;
    }
    yield* Console.log(
      `Configured providers: ${configured
        .map((entry) => `${entry.provider.displayName} (${entry.source})`)
        .join(", ")}`,
    );
    const catalog = yield* ModelCatalog.ModelCatalog;
    const models = yield* catalog.models(configured.map((entry) => entry.provider.id));
    if (models.length === 0) {
      yield* Console.log("The catalog returned no models for the configured providers.");
      return;
    }
    yield* Effect.forEach(models, (model) => Console.log(`  ${model.provider}/${model.id}  ${model.name}`), {
      discard: true,
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(credentialsLayer(options.credentials), ModelCatalog.layer).pipe(
        Layer.provide(FetchHttpClient.layer),
      ),
    ),
    Effect.tapError((error) => Console.error(error instanceof Error ? error.message : String(error))),
  );

export const modelsCommand = Command.make("models", { credentials: credentialsFlag }).pipe(
  Command.withHandler(runModels),
);
