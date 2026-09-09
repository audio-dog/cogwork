import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { CredentialError, type CredentialStoreService } from "./credential-store";
import { defaultModelAdapterFactory, type ModelAdapterFactory } from "./provider-adapter";
import { ProviderResolutionError, resolveModelAdapter } from "./provider-resolve";

const SECRET = "sk-super-secret-value";

const unexpected = () => Effect.die(new Error("credential store method not expected in this test"));

const credentialStore = (providerKey: CredentialStoreService["providerKey"]): CredentialStoreService => ({
  bearerToken: unexpected,
  resolveSource: unexpected,
  persist: unexpected,
  invalidate: () => Effect.void,
  providerKey,
  persistProviderKey: unexpected,
  configureConnection: unexpected,
  removeConnection: unexpected,
});

const keyProvider: CredentialStoreService["providerKey"] = () =>
  Effect.succeed({ source: "env", key: Redacted.make(SECRET) });

const missingKeyProvider: CredentialStoreService["providerKey"] = () =>
  Effect.fail(new CredentialError({ account: "openai", message: "no api key for openai", retryable: false }));

describe("resolveModelAdapter", () => {
  it.effect("builds an adapter and hands the resolved key to the factory", () =>
    Effect.gen(function* () {
      const calls: Array<{ provider: string; model: string; key: Redacted.Redacted<string> }> = [];
      const makeAdapter: ModelAdapterFactory = (resolved, key) => {
        calls.push({ provider: resolved.provider, model: resolved.model, key });
        return defaultModelAdapterFactory(resolved, key);
      };

      const adapter = yield* resolveModelAdapter(credentialStore(keyProvider), "openai/gpt-4o", makeAdapter);

      assert.isNotNull(adapter);
      assert.lengthOf(calls, 1);
      assert.strictEqual(calls[0]?.provider, "openai");
      assert.strictEqual(calls[0]?.model, "gpt-4o");
      assert.strictEqual(calls[0] ? Redacted.value(calls[0].key) : null, SECRET);
    }),
  );

  it.effect("fails unknown-model when the provider prefix is not wired", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        resolveModelAdapter(credentialStore(keyProvider), "openrouter/some-model"),
      );
      assert.instanceOf(error, ProviderResolutionError);
      assert.strictEqual(error.reason, "unknown-model");
    }),
  );

  it.effect("fails unknown-model when the factory has no adapter for the model", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        resolveModelAdapter(credentialStore(keyProvider), "openai/gpt-4o", () => null),
      );
      assert.instanceOf(error, ProviderResolutionError);
      assert.strictEqual(error.reason, "unknown-model");
    }),
  );

  it.effect("fails no-key when no api key resolves for the provider", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        resolveModelAdapter(credentialStore(missingKeyProvider), "openai/gpt-4o"),
      );
      assert.instanceOf(error, ProviderResolutionError);
      assert.strictEqual(error.reason, "no-key");
    }),
  );
});
