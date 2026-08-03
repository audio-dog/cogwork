import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import { CredentialStore, layerEnv } from "./CredentialStore";

const account = { key: "AUD", tokenEnv: "LINEAR_API_KEY" } as const;

const withEnv = (env: Record<string, string>) =>
  Effect.provide(Layer.mergeAll(layerEnv, ConfigProvider.layer(ConfigProvider.fromEnv({ env }))));

const capturingLogs = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
  const lines: Array<string> = [];
  const logger = Logger.make<unknown, void>(({ message }) => {
    lines.push(JSON.stringify(message));
  });
  return effect.pipe(
    Effect.provide(Logger.layer([logger])),
    Effect.provideService(References.MinimumLogLevel, "Debug"),
    Effect.map(() => lines as ReadonlyArray<string>),
  );
};

describe("CredentialStore (env)", () => {
  it.effect("returns the token held by the account's env var", () =>
    Effect.gen(function* () {
      const store = yield* CredentialStore;
      const token = yield* store.bearerToken(account);
      assert.strictEqual(Redacted.value(token), "test-key");
    }).pipe(withEnv({ LINEAR_API_KEY: "test-key" })),
  );

  it.effect("reads the env var the account names rather than a default", () =>
    Effect.gen(function* () {
      const store = yield* CredentialStore;
      const token = yield* store.bearerToken({ key: "AUD", tokenEnv: "OTHER_LINEAR_KEY" });
      assert.strictEqual(Redacted.value(token), "other-key");
    }).pipe(withEnv({ LINEAR_API_KEY: "test-key", OTHER_LINEAR_KEY: "other-key" })),
  );

  it.effect("fails when the env var is unset", () =>
    Effect.gen(function* () {
      const store = yield* CredentialStore;
      const error = yield* Effect.flip(store.bearerToken(account));
      assert.strictEqual(error.account, "AUD");
      assert.include(error.message, "LINEAR_API_KEY");
    }).pipe(withEnv({})),
  );

  it.effect("fails when the env var holds only whitespace", () =>
    Effect.gen(function* () {
      const store = yield* CredentialStore;
      const error = yield* Effect.flip(store.bearerToken(account));
      assert.include(error.message, "LINEAR_API_KEY");
    }).pipe(withEnv({ LINEAR_API_KEY: "  " })),
  );

  it.effect("logs the credential source it resolved from", () =>
    Effect.gen(function* () {
      const store = yield* CredentialStore;
      const lines = yield* capturingLogs(store.bearerToken(account));
      assert.isTrue(lines.some((line) => line.includes("env") && line.includes("AUD")));
    }).pipe(withEnv({ LINEAR_API_KEY: "test-key" })),
  );
});
