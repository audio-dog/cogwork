import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { CredentialStoreService } from "./credential-store";
import { defaultModelAdapterFactory, type ModelAdapterFactory, parseModelRef } from "./provider-adapter";
import { accountFor, findProvider } from "./providers";

export class ProviderResolutionError extends Schema.TaggedError<ProviderResolutionError>()(
  "ProviderResolutionError",
  {
    reason: Schema.Literals(["unknown-model", "no-key"]),
    model: Schema.String,
    message: Schema.String,
  },
) {}

const unknownModelMessage = (model: string) =>
  `no provider adapter for model "${model}"; use provider/model with a wired provider (openai, anthropic, google)`;

export const resolveModelAdapter = Effect.fn("provider.resolveModelAdapter")(function* (
  credentials: CredentialStoreService,
  reference: string,
  makeAdapter: ModelAdapterFactory = defaultModelAdapterFactory,
) {
  const resolved = parseModelRef(reference);
  const provider = resolved ? findProvider(resolved.provider) : undefined;
  if (!resolved || provider === undefined) {
    return yield* new ProviderResolutionError({
      reason: "unknown-model",
      model: reference,
      message: unknownModelMessage(reference),
    });
  }

  const credential = yield* credentials
    .providerKey(accountFor(provider))
    .pipe(
      Effect.mapError(
        (error) =>
          new ProviderResolutionError({ reason: "no-key", model: reference, message: error.message }),
      ),
    );

  const adapter = makeAdapter(resolved, credential.key);
  if (adapter === null) {
    return yield* new ProviderResolutionError({
      reason: "unknown-model",
      model: reference,
      message: unknownModelMessage(reference),
    });
  }
  return adapter;
});
