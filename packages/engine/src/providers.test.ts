import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import { CredentialStore, make, type StoredProviderKey } from "./credential-store";
import { accountFor, configuredProviders, findProvider, supportedProviders } from "./providers";

const withStore = (providerKeys: ReadonlyArray<StoredProviderKey>, env: Record<string, string> = {}) =>
  Effect.provide(
    Layer.mergeAll(
      Layer.succeed(
        CredentialStore,
        make({
          stored: {
            load: Effect.succeed([]),
            save: () => Effect.void,
            loadProviderKeys: Effect.succeed(providerKeys),
          },
        }),
      ),
      ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
    ),
  );

describe("supportedProviders", () => {
  it("names the four providers with the runner behind them", () => {
    assert.deepStrictEqual(
      supportedProviders.map((provider) => provider.id),
      ["anthropic", "openai", "openrouter", "google"],
    );
  });

  it("derives a provider account from the registry entry", () => {
    const google = findProvider("google");
    assert.ok(google);
    assert.deepStrictEqual(accountFor(google), {
      provider: "google",
      envVars: ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
    });
  });
});

describe("configuredProviders", () => {
  it.effect("lists only providers with a resolvable key, tagged with the source", () =>
    Effect.gen(function* () {
      const configured = yield* configuredProviders();
      assert.deepStrictEqual(
        configured.map((entry) => [entry.provider.id, entry.source]),
        [
          ["openrouter", "stored-key"],
          ["google", "env"],
        ],
      );
    }).pipe(
      withStore([{ provider: "openrouter", key: Redacted.make("sk-or-1") }], { GEMINI_API_KEY: "sk-gem" }),
    ),
  );

  it.effect("returns nothing when no provider has a key", () =>
    Effect.gen(function* () {
      const configured = yield* configuredProviders();
      assert.deepStrictEqual(configured, []);
    }).pipe(withStore([])),
  );
});
