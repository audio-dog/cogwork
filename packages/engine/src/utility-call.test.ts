import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { CredentialError, type CredentialStoreService } from "./credential-store";
import { defaultModelAdapterFactory, type ModelAdapterFactory } from "./provider-adapter";
import {
  defaultUtilityModel,
  make,
  UtilityCallError,
  type UtilityChat,
  type UtilityChatOptions,
} from "./utility-call";

const SECRET = "sk-super-secret-value";

const unexpected = () => Effect.die(new Error("credential store method not expected in this test"));

const credentialStore = (providerKey: CredentialStoreService["providerKey"]): CredentialStoreService => ({
  bearerToken: unexpected,
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
  Effect.fail(new CredentialError({ account: "anthropic", message: "no api key for anthropic" }));

describe("UtilityModel.complete", () => {
  it.effect("resolves the adapter, runs one turn, and returns the reply", () =>
    Effect.gen(function* () {
      const captured: Array<UtilityChatOptions> = [];
      const adapterCalls: Array<{ provider: string; model: string; key: Redacted.Redacted<string> }> = [];

      const makeAdapter: ModelAdapterFactory = (resolved, key) => {
        adapterCalls.push({ provider: resolved.provider, model: resolved.model, key });
        return defaultModelAdapterFactory(resolved, key);
      };
      const runChat: UtilityChat = (options) => {
        captured.push(options);
        return Promise.resolve("routed: build");
      };

      const utility = make(credentialStore(keyProvider), { makeAdapter, runChat });
      const reply = yield* utility.complete({
        model: "openai/gpt-4o",
        system: "You route work.",
        prompt: "classify this",
      });

      assert.strictEqual(reply, "routed: build");
      assert.lengthOf(adapterCalls, 1);
      assert.strictEqual(adapterCalls[0]?.provider, "openai");
      assert.strictEqual(adapterCalls[0]?.model, "gpt-4o");
      assert.strictEqual(adapterCalls[0] ? Redacted.value(adapterCalls[0].key) : null, SECRET);

      const options = captured[0];
      if (!options) return assert.fail("runChat was never invoked");
      assert.strictEqual(options.system, "You route work.");
      assert.strictEqual(options.prompt, "classify this");
    }),
  );

  it.effect("falls back to the default utility model when none is named", () =>
    Effect.gen(function* () {
      const adapterCalls: Array<{ provider: string; model: string }> = [];
      const makeAdapter: ModelAdapterFactory = (resolved, key) => {
        adapterCalls.push({ provider: resolved.provider, model: resolved.model });
        return defaultModelAdapterFactory(resolved, key);
      };
      const runChat: UtilityChat = () => Promise.resolve("ok");

      const utility = make(credentialStore(keyProvider), { makeAdapter, runChat });
      yield* utility.complete({ prompt: "summarize" });

      const [provider, model] = defaultUtilityModel.split("/");
      assert.strictEqual(adapterCalls[0]?.provider, provider);
      assert.strictEqual(adapterCalls[0]?.model, model);
    }),
  );

  it.effect("fails with a UtilityCallError when no api key resolves", () =>
    Effect.gen(function* () {
      const utility = make(credentialStore(missingKeyProvider), { runChat: () => Promise.resolve("ok") });
      const error = yield* Effect.flip(utility.complete({ prompt: "summarize" }));
      assert.instanceOf(error, UtilityCallError);
      assert.strictEqual(error.model, defaultUtilityModel);
    }),
  );

  it.effect("fails with a UtilityCallError when the model has no wired provider", () =>
    Effect.gen(function* () {
      const utility = make(credentialStore(keyProvider), { runChat: () => Promise.resolve("ok") });
      const error = yield* Effect.flip(utility.complete({ model: "openrouter/whatever", prompt: "hi" }));
      assert.instanceOf(error, UtilityCallError);
      assert.strictEqual(error.model, "openrouter/whatever");
    }),
  );

  it.effect("surfaces a rejected chat as a UtilityCallError", () =>
    Effect.gen(function* () {
      const runChat: UtilityChat = () => Promise.reject(new Error("provider exploded"));
      const utility = make(credentialStore(keyProvider), { runChat });
      const error = yield* Effect.flip(utility.complete({ model: "openai/gpt-4o", prompt: "hi" }));
      assert.instanceOf(error, UtilityCallError);
      assert.strictEqual(error.message, "provider exploded");
    }),
  );
});
