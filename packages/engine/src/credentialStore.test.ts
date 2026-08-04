import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import {
  type ClientCredentialsGrant,
  CredentialError,
  CredentialStore,
  layerEnv,
  make,
  type StoredCredential,
  type StoredToken,
} from "./CredentialStore";

const account = {
  key: "AUD",
  workSource: "linear",
  organization: null,
  tokenEnv: "LINEAR_API_KEY",
  clientCredentials: null,
} as const;

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
      const credential = yield* store.bearerToken(account);
      assert.strictEqual(Redacted.value(credential.token), "test-key");
      assert.strictEqual(credential.source, "env");
    }).pipe(withEnv({ LINEAR_API_KEY: "test-key" })),
  );

  it.effect("reads the env var the account names rather than a default", () =>
    Effect.gen(function* () {
      const store = yield* CredentialStore;
      const credential = yield* store.bearerToken({ ...account, tokenEnv: "OTHER_LINEAR_KEY" });
      assert.strictEqual(Redacted.value(credential.token), "other-key");
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

const storedToken = (expiresAtMillis: number, accessToken = "oauth-token"): StoredToken => ({
  accessToken: Redacted.make(accessToken),
  refreshToken: null,
  expiresAtMillis,
  scopes: ["read", "write"],
});

const stored = (organization: string, token: StoredToken): StoredCredential => ({
  workSource: "linear",
  organization,
  botUserId: `bot-${organization}`,
  token,
});

const far = 4_000_000_000_000;

const withStored = (
  credentials: ReadonlyArray<StoredCredential>,
  env: Record<string, string> = { LINEAR_API_KEY: "env-key" },
) =>
  Effect.provide(
    Layer.mergeAll(
      Layer.succeed(
        CredentialStore,
        make({ stored: { load: Effect.succeed(credentials), save: () => Effect.void } }),
      ),
      ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
    ),
  );

describe("CredentialStore (stored)", () => {
  it.effect("prefers a live stored token over the account's env var", () =>
    Effect.gen(function* () {
      const store = yield* CredentialStore;
      const credential = yield* store.bearerToken(account);
      assert.strictEqual(credential.source, "stored-oauth");
      assert.strictEqual(Redacted.value(credential.token), "oauth-token");
    }).pipe(withStored([stored("acme", storedToken(far))])),
  );

  it.effect("reports the identity discovered alongside the stored token", () =>
    Effect.gen(function* () {
      const store = yield* CredentialStore;
      const credential = yield* store.bearerToken(account);
      assert.deepStrictEqual(credential.identity, { organization: "acme", botUserId: "bot-acme" });
    }).pipe(withStored([stored("acme", storedToken(far))])),
  );

  it.effect("falls back to the env var once the stored token has expired", () =>
    Effect.gen(function* () {
      const store = yield* CredentialStore;
      const credential = yield* store.bearerToken(account);
      assert.strictEqual(credential.source, "env");
      assert.strictEqual(Redacted.value(credential.token), "env-key");
    }).pipe(withStored([stored("acme", storedToken(0))])),
  );

  const expiringIn = (millis: number) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const store = make({
        stored: {
          load: Effect.succeed([stored("acme", storedToken(now + millis))]),
          save: () => Effect.void,
        },
      });
      return yield* store.bearerToken(account);
    }).pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { LINEAR_API_KEY: "env-key" } }))),
    );

  it.effect("treats a token expiring inside the safety margin as expired", () =>
    Effect.map(expiringIn(30_000), (credential) => assert.strictEqual(credential.source, "env")),
  );

  it.effect("still uses a token that outlives the safety margin", () =>
    Effect.map(expiringIn(90_000), (credential) => assert.strictEqual(credential.source, "stored-oauth")),
  );

  it.effect("uses the stored token whose organization the account names", () =>
    Effect.gen(function* () {
      const store = yield* CredentialStore;
      const credential = yield* store.bearerToken({ ...account, organization: "beta" });
      assert.strictEqual(Redacted.value(credential.token), "beta-token");
    }).pipe(
      withStored([
        stored("acme", storedToken(far, "acme-token")),
        stored("beta", storedToken(far, "beta-token")),
      ]),
    ),
  );

  it.effect("never hands one work source's token to another", () =>
    Effect.gen(function* () {
      const store = yield* CredentialStore;
      const credential = yield* store.bearerToken({ ...account, workSource: "github" });
      assert.strictEqual(credential.source, "env");
    }).pipe(withStored([stored("acme", storedToken(far))])),
  );

  it.effect("refuses to guess when several stored tokens could match", () =>
    Effect.gen(function* () {
      const store = yield* CredentialStore;
      const credential = yield* store.bearerToken(account);
      assert.strictEqual(credential.source, "env");
    }).pipe(withStored([stored("acme", storedToken(far)), stored("beta", storedToken(far))])),
  );

  it.effect("fails when neither a stored token nor the env var is usable", () =>
    Effect.gen(function* () {
      const store = yield* CredentialStore;
      const error = yield* Effect.flip(store.bearerToken(account));
      assert.include(error.message, "LINEAR_API_KEY");
    }).pipe(withStored([stored("acme", storedToken(0))], {})),
  );

  it.effect("logs that it resolved from the stored credential", () =>
    Effect.gen(function* () {
      const store = yield* CredentialStore;
      const lines = yield* capturingLogs(store.bearerToken(account));
      assert.isTrue(lines.some((line) => line.includes("stored-oauth")));
    }).pipe(withStored([stored("acme", storedToken(far))])),
  );
});

const requesting = {
  ...account,
  clientCredentials: { clientId: "client-1", secretEnv: "LINEAR_CLIENT_SECRET" },
};

interface GrantCalls {
  readonly minted: ReadonlyArray<string>;
  readonly forgotten: ReadonlyArray<string>;
}

const recordingGrant = (secret: string | null) => {
  const minted: Array<string> = [];
  const forgotten: Array<string> = [];
  const grant: ClientCredentialsGrant = {
    token: (account) => {
      if (!account.clientCredentials) return Effect.succeed(null);
      if (secret === null) {
        return Effect.fail(
          new CredentialError({
            account: account.key,
            message: `client credentials for ${account.key} need ${account.clientCredentials.secretEnv}, which is unset or empty`,
          }),
        );
      }
      minted.push(account.key);
      return Effect.succeed(Redacted.make(secret));
    },
    forget: (account) => Effect.sync(() => forgotten.push(account.key)),
  };
  return { grant, calls: { minted, forgotten } as GrantCalls };
};

const withGrant = (
  grant: ClientCredentialsGrant,
  credentials: ReadonlyArray<StoredCredential> = [],
  env: Record<string, string> = { LINEAR_API_KEY: "env-key" },
) =>
  Effect.provide(
    Layer.mergeAll(
      Layer.succeed(
        CredentialStore,
        make({
          stored: { load: Effect.succeed(credentials), save: () => Effect.void },
          clientCredentials: grant,
        }),
      ),
      ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
    ),
  );

describe("CredentialStore (client credentials)", () => {
  it.effect("mints a client-credentials token when no stored token is present", () =>
    Effect.gen(function* () {
      const store = yield* CredentialStore;
      const credential = yield* store.bearerToken(requesting);
      assert.strictEqual(credential.source, "client-credentials");
      assert.strictEqual(Redacted.value(credential.token), "app-token");
    }).pipe(withGrant(recordingGrant("app-token").grant)),
  );

  it.effect("keeps using the env key for an account that never asked for client credentials", () =>
    Effect.gen(function* () {
      const store = yield* CredentialStore;
      const credential = yield* store.bearerToken(account);
      assert.strictEqual(credential.source, "env");
      assert.strictEqual(Redacted.value(credential.token), "env-key");
    }).pipe(withGrant(recordingGrant("app-token").grant)),
  );

  it.effect("lets a live stored token win over client credentials", () => {
    const { grant, calls } = recordingGrant("app-token");
    return Effect.gen(function* () {
      const store = yield* CredentialStore;
      const credential = yield* store.bearerToken(requesting);
      assert.strictEqual(credential.source, "stored-oauth");
      assert.deepStrictEqual(calls.minted, []);
    }).pipe(withGrant(grant, [stored("acme", storedToken(far))]));
  });

  it.effect("surfaces the missing-secret error instead of quietly using the env key", () =>
    Effect.gen(function* () {
      const store = yield* CredentialStore;
      const error = yield* Effect.flip(store.bearerToken(requesting));
      assert.include(error.message, "LINEAR_CLIENT_SECRET");
    }).pipe(withGrant(recordingGrant(null).grant)),
  );

  it.effect("logs that it resolved from client credentials", () =>
    Effect.gen(function* () {
      const store = yield* CredentialStore;
      const lines = yield* capturingLogs(store.bearerToken(requesting));
      assert.isTrue(lines.some((line) => line.includes("client-credentials")));
    }).pipe(withGrant(recordingGrant("app-token").grant)),
  );

  it.effect("asks the grant to forget a rejected token", () => {
    const { grant, calls } = recordingGrant("app-token");
    return Effect.gen(function* () {
      const store = yield* CredentialStore;
      yield* store.invalidate(requesting);
      assert.deepStrictEqual(calls.forgotten, ["AUD"]);
    }).pipe(withGrant(grant));
  });

  it.effect("has nothing to forget when no client-credentials source is wired", () =>
    Effect.gen(function* () {
      const store = yield* CredentialStore;
      yield* store.invalidate(requesting);
    }).pipe(withEnv({})),
  );
});
