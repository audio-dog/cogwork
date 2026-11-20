import * as Effect from "effect/Effect";

import { CredentialStore, type ProviderAccount, type ProviderKeySource } from "./credential-store";

export interface SupportedProvider {
  readonly id: string;
  readonly displayName: string;
  readonly envVars: ReadonlyArray<string>;
}

export const supportedProviders: ReadonlyArray<SupportedProvider> = [
  { id: "anthropic", displayName: "Anthropic", envVars: ["ANTHROPIC_API_KEY"] },
  { id: "openai", displayName: "OpenAI", envVars: ["OPENAI_API_KEY"] },
  { id: "openrouter", displayName: "OpenRouter", envVars: ["OPENROUTER_API_KEY"] },
  { id: "google", displayName: "Google", envVars: ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"] },
];

export const findProvider = (id: string) => supportedProviders.find((provider) => provider.id === id);

export const accountFor = (provider: SupportedProvider): ProviderAccount => ({
  provider: provider.id,
  envVars: provider.envVars,
});

export interface ConfiguredProvider {
  readonly provider: SupportedProvider;
  readonly source: ProviderKeySource;
}

export const configuredProviders = Effect.fn("providers.configured")(function* () {
  const store = yield* CredentialStore;
  const resolved = yield* Effect.forEach(supportedProviders, (provider) =>
    store.providerKey(accountFor(provider)).pipe(
      Effect.map((credential): ReadonlyArray<ConfiguredProvider> => [
        { provider, source: credential.source },
      ]),
      Effect.orElseSucceed((): ReadonlyArray<ConfiguredProvider> => []),
    ),
  );
  return resolved.flat();
});
