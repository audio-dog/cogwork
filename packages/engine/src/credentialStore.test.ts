import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as References from "effect/References";
import {
  accountOf,
  CredentialError,
  CredentialStore,
  type CredentialStoreService,
  layerEnv,
  make,
  type StoredCredential,
  type StoredCredentials,
  type StoredToken,
  type TokenRefresh,
} from "./CredentialStore";

const account = {
  key: "AUD",
  workSource: "linear",
  organization: null,
  tokenEnv: "LINEAR_API_KEY",
  clientId: null,
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
      Layer.succeed(CredentialStore, make({ load: Effect.succeed(credentials), save: () => Effect.void })),
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
        load: Effect.succeed([stored("acme", storedToken(now + millis))]),
        save: () => Effect.void,
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

const oauthAccount = { ...account, clientId: "client-1" };

const expiredWithRefresh = (refreshToken = "refresh-1"): StoredToken => ({
  ...storedToken(0),
  refreshToken: Redacted.make(refreshToken),
});

const rotatedToken = (refreshToken: string | null = "refresh-2"): StoredToken => ({
  accessToken: Redacted.make("rotated-token"),
  refreshToken: refreshToken === null ? null : Redacted.make(refreshToken),
  expiresAtMillis: far,
  scopes: ["read", "write"],
});

interface Harness {
  readonly store: CredentialStoreService;
  readonly refreshes: Effect.Effect<number>;
  readonly savedToken: Effect.Effect<StoredToken | undefined>;
}

const harness = Effect.fn("harness")(function* (options: {
  readonly initial: ReadonlyArray<StoredCredential>;
  readonly onRefresh: (attempt: number) => Effect.Effect<StoredToken, CredentialError>;
}) {
  const credentials = yield* Ref.make(options.initial);
  const attempts = yield* Ref.make(0);
  const refresh: TokenRefresh = () =>
    Effect.gen(function* () {
      const attempt = yield* Ref.updateAndGet(attempts, (count) => count + 1);
      yield* Effect.yieldNow;
      return yield* options.onRefresh(attempt);
    });
  const stored: StoredCredentials = {
    load: Ref.get(credentials),
    save: (credential) =>
      Ref.update(credentials, (entries) => [
        ...entries.filter((entry) => accountOf(entry) !== accountOf(credential)),
        credential,
      ]),
  };
  return {
    store: make(stored, refresh),
    refreshes: Ref.get(attempts),
    savedToken: Effect.map(Ref.get(credentials), (entries) => entries[0]?.token),
  } satisfies Harness;
});

const withRefreshEnv = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provide(
    effect,
    ConfigProvider.layer(ConfigProvider.fromEnv({ env: { LINEAR_API_KEY: "env-key" } })),
  );

describe("CredentialStore (refresh)", () => {
  it.effect("refreshes an expired token and hands back the rotated one", () =>
    Effect.gen(function* () {
      const { store, refreshes } = yield* harness({
        initial: [stored("acme", expiredWithRefresh())],
        onRefresh: () => Effect.succeed(rotatedToken()),
      });
      const credential = yield* store.bearerToken(oauthAccount);
      assert.strictEqual(credential.source, "stored-oauth");
      assert.strictEqual(Redacted.value(credential.token), "rotated-token");
      assert.strictEqual(yield* refreshes, 1);
    }).pipe(withRefreshEnv),
  );

  it.effect("writes the rotated pair back so the file stays the source of truth", () =>
    Effect.gen(function* () {
      const { store, savedToken } = yield* harness({
        initial: [stored("acme", expiredWithRefresh())],
        onRefresh: () => Effect.succeed(rotatedToken()),
      });
      yield* store.bearerToken(oauthAccount);
      const token = yield* savedToken;
      assert.strictEqual(token && Redacted.value(token.accessToken), "rotated-token");
      assert.strictEqual(token?.refreshToken && Redacted.value(token.refreshToken), "refresh-2");
    }).pipe(withRefreshEnv),
  );

  it.effect("keeps the previous refresh token when the response rotates only the access token", () =>
    Effect.gen(function* () {
      const { store, savedToken } = yield* harness({
        initial: [stored("acme", expiredWithRefresh())],
        onRefresh: () => Effect.succeed(rotatedToken(null)),
      });
      yield* store.bearerToken(oauthAccount);
      const token = yield* savedToken;
      assert.strictEqual(token?.refreshToken && Redacted.value(token.refreshToken), "refresh-1");
    }).pipe(withRefreshEnv),
  );

  it.effect("refreshes once for concurrent gets", () =>
    Effect.gen(function* () {
      const { store, refreshes } = yield* harness({
        initial: [stored("acme", expiredWithRefresh())],
        onRefresh: () => Effect.succeed(rotatedToken()),
      });
      const credentials = yield* Effect.all(
        [store.bearerToken(oauthAccount), store.bearerToken(oauthAccount), store.bearerToken(oauthAccount)],
        { concurrency: "unbounded" },
      );
      assert.strictEqual(yield* refreshes, 1);
      assert.deepStrictEqual(
        credentials.map((credential) => Redacted.value(credential.token)),
        ["rotated-token", "rotated-token", "rotated-token"],
      );
    }).pipe(withRefreshEnv),
  );

  it.effect("refreshes once when two accounts resolve to the same stored credential", () =>
    Effect.gen(function* () {
      const { store, refreshes } = yield* harness({
        initial: [stored("acme", expiredWithRefresh())],
        onRefresh: () => Effect.succeed(rotatedToken()),
      });
      const credentials = yield* Effect.all(
        [
          store.bearerToken({ ...oauthAccount, key: "AUD-alpha" }),
          store.bearerToken({ ...oauthAccount, key: "AUD-beta" }),
        ],
        { concurrency: "unbounded" },
      );
      assert.strictEqual(yield* refreshes, 1);
      assert.deepStrictEqual(
        credentials.map((credential) => Redacted.value(credential.token)),
        ["rotated-token", "rotated-token"],
      );
    }).pipe(withRefreshEnv),
  );

  it.effect("does not refresh again once the rotated token is stored", () =>
    Effect.gen(function* () {
      const { store, refreshes } = yield* harness({
        initial: [stored("acme", expiredWithRefresh())],
        onRefresh: () => Effect.succeed(rotatedToken()),
      });
      yield* store.bearerToken(oauthAccount);
      yield* store.bearerToken(oauthAccount);
      assert.strictEqual(yield* refreshes, 1);
    }).pipe(withRefreshEnv),
  );

  it.effect("surfaces a failed refresh instead of falling back to the environment", () =>
    Effect.gen(function* () {
      const { store } = yield* harness({
        initial: [stored("acme", expiredWithRefresh())],
        onRefresh: () =>
          Effect.fail(new CredentialError({ account: "AUD", message: "refresh grant rejected" })),
      });
      const error = yield* Effect.flip(store.bearerToken(oauthAccount));
      assert.strictEqual(error.account, "AUD");
      assert.include(error.message, "refresh grant rejected");
    }).pipe(withRefreshEnv),
  );

  it.effect("falls back to the environment when the account has no OAuth client id", () =>
    Effect.gen(function* () {
      const { store, refreshes } = yield* harness({
        initial: [stored("acme", expiredWithRefresh())],
        onRefresh: () => Effect.succeed(rotatedToken()),
      });
      const credential = yield* store.bearerToken(account);
      assert.strictEqual(credential.source, "env");
      assert.strictEqual(yield* refreshes, 0);
    }).pipe(withRefreshEnv),
  );

  it.effect("reports an auth error when no refresh is wired into the store", () =>
    Effect.gen(function* () {
      const store = make({
        load: Effect.succeed([stored("acme", expiredWithRefresh())]),
        save: () => Effect.void,
      });
      const error = yield* Effect.flip(store.bearerToken(oauthAccount));
      assert.include(error.message, "no token refresh");
    }).pipe(withRefreshEnv),
  );
});
