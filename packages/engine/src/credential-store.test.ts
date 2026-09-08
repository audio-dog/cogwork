import { ConnectionId } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as MutableRef from "effect/MutableRef";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import {
  accountOf,
  type ClientCredentialsGrant,
  CredentialError,
  CredentialStore,
  type CredentialStoreService,
  layerEnv,
  make,
  type StoredCredential,
  type StoredCredentials,
  type StoredProviderKey,
  type StoredToken,
  type TokenRefresh,
} from "./credential-store";

const account = {
  key: "AUD",
  issueTracker: "linear",
  organization: null,
  tokenEnv: "LINEAR_API_KEY",
  clientCredentials: null,
  oauthClientId: null,
} as const;
const connectionId = Schema.decodeSync(ConnectionId);

const withEnv = (env: Record<string, string>) =>
  Effect.provide(Layer.mergeAll(layerEnv, ConfigProvider.layer(ConfigProvider.fromEnv({ env }))));

interface CapturedLog {
  readonly annotations: Record<string, unknown>;
  readonly message: unknown;
}

class CredentialLogProbe extends Context.Service<
  CredentialLogProbe,
  MutableRef.MutableRef<ReadonlyArray<CapturedLog>>
>()("@cogwork/engine/credential-store.test/CredentialLogProbe") {
  static readonly layer = Layer.sync(CredentialLogProbe, () =>
    MutableRef.make<ReadonlyArray<CapturedLog>>([]),
  );
  static readonly captureLayer = Logger.layer([
    Effect.map(CredentialLogProbe, (logs) =>
      Logger.make<unknown, void>(({ fiber, message }) =>
        MutableRef.update(logs, (current) => [
          ...current,
          { message, annotations: { ...fiber.getRef(References.CurrentLogAnnotations) } },
        ]),
      ),
    ),
  ]).pipe(
    Layer.provideMerge(CredentialLogProbe.layer),
    Layer.provideMerge(Layer.succeed(References.MinimumLogLevel)("Debug")),
  );
}

const logMessageIncludes = ({ message }: CapturedLog, text: string) => JSON.stringify(message).includes(text);

const capturingLogs = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const logs = yield* CredentialLogProbe;
    yield* effect;
    return MutableRef.get(logs);
  });

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

  it.layer(CredentialLogProbe.captureLayer)("logging", (it) => {
    it.effect("logs the credential source it resolved from", () =>
      Effect.gen(function* () {
        const store = yield* CredentialStore;
        const logs = yield* capturingLogs(store.bearerToken(account));
        const log = logs.find((candidate) => logMessageIncludes(candidate, "credential resolved"));
        assert.deepStrictEqual(log?.annotations, { account: "AUD" });
        assert.deepStrictEqual(log?.message, ["credential resolved", { source: "env" }]);
      }).pipe(withEnv({ LINEAR_API_KEY: "test-key" })),
    );
  });
});

describe("CredentialStore (Connections)", () => {
  it.effect("stores and resolves a Connection API key", () =>
    Effect.gen(function* () {
      const entries = yield* Ref.make<ReadonlyArray<import("./credential-store").StoredConnectionCredential>>(
        [],
      );
      const store = make({
        stored: {
          load: Effect.succeed([]),
          save: () => Effect.void,
          loadConnectionCredentials: Ref.get(entries),
          saveConnectionCredential: (entry) =>
            Ref.update(entries, (current) => [
              ...current.filter((candidate) => candidate.connectionId !== entry.connectionId),
              entry,
            ]),
        },
      });
      yield* store.configureConnection(connectionId("linear/acme"), {
        _tag: "ApiKey",
        key: Redacted.make("stored-key"),
      });
      const credential = yield* store.bearerToken({
        ...account,
        connectionId: connectionId("linear/acme"),
      });

      assert.strictEqual(credential.source, "stored-key");
      assert.strictEqual(Redacted.value(credential.token), "stored-key");
    }),
  );

  it.effect("resolves the env var selected for a Connection", () =>
    Effect.gen(function* () {
      const store = make({
        stored: {
          load: Effect.succeed([]),
          save: () => Effect.void,
          loadConnectionCredentials: Effect.succeed([
            { _tag: "Env", connectionId: connectionId("github/default"), name: "GH_WORK_TOKEN" },
          ]),
        },
      });
      const credential = yield* store.bearerToken({
        ...account,
        key: "github/default",
        issueTracker: "github",
        connectionId: connectionId("github/default"),
      });

      assert.strictEqual(credential.source, "env");
      assert.strictEqual(Redacted.value(credential.token), "env-token");
    }).pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { GH_WORK_TOKEN: "env-token" } }))),
    ),
  );

  it.effect("uses only the saved browser grant selected for a Connection", () =>
    Effect.gen(function* () {
      const entries = yield* Ref.make<ReadonlyArray<import("./credential-store").StoredConnectionCredential>>(
        [{ _tag: "ApiKey", connectionId: connectionId("linear/acme"), key: Redacted.make("old-key") }],
      );
      const store = make({
        stored: {
          load: Effect.succeed([stored("acme", storedToken(far))]),
          save: () => Effect.void,
          loadConnectionCredentials: Ref.get(entries),
          saveConnectionCredential: (entry) =>
            Ref.update(entries, (current) => [
              ...current.filter((candidate) => candidate.connectionId !== entry.connectionId),
              entry,
            ]),
        },
      });
      yield* store.configureConnection(connectionId("linear/acme"), { _tag: "Stored" });
      const credential = yield* store.bearerToken({
        ...account,
        key: "linear/acme",
        organization: "acme",
        connectionId: connectionId("linear/acme"),
      });

      assert.strictEqual(credential.source, "stored-oauth");
      assert.strictEqual(Redacted.value(credential.token), "oauth-token");
      assert.strictEqual((yield* Ref.get(entries))[0]?._tag, "Stored");
    }),
  );

  it.effect("keeps the previous source when replacement browser validation fails", () =>
    Effect.gen(function* () {
      const entries = yield* Ref.make<ReadonlyArray<import("./credential-store").StoredConnectionCredential>>(
        [{ _tag: "ApiKey", connectionId: connectionId("linear/acme"), key: Redacted.make("working-key") }],
      );
      const store = make({
        stored: {
          load: Effect.succeed([]),
          save: () => Effect.void,
          loadConnectionCredentials: Ref.get(entries),
          saveConnectionCredential: (entry) =>
            Ref.update(entries, (current) => [
              ...current.filter((candidate) => candidate.connectionId !== entry.connectionId),
              entry,
            ]),
        },
      });
      const error = yield* Effect.flip(
        store.configureConnection(connectionId("linear/acme"), { _tag: "Stored" }),
      );
      const credential = yield* store.bearerToken({
        ...account,
        key: "linear/acme",
        organization: "acme",
        connectionId: connectionId("linear/acme"),
      });

      assert.include(error.message, "no saved browser login");
      assert.strictEqual(Redacted.value(credential.token), "working-key");
    }),
  );

  it.effect("does not fall through to the default environment for a missing saved grant", () =>
    Effect.gen(function* () {
      const store = make({
        stored: {
          load: Effect.succeed([]),
          save: () => Effect.void,
          loadConnectionCredentials: Effect.succeed([
            { _tag: "Stored", connectionId: connectionId("linear/acme") },
          ]),
        },
      });
      const error = yield* Effect.flip(
        store.bearerToken({
          ...account,
          key: "linear/acme",
          organization: "acme",
          connectionId: connectionId("linear/acme"),
        }),
      );

      assert.include(error.message, "no saved browser login");
    }).pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { LINEAR_API_KEY: "env-key" } }))),
    ),
  );

  it.effect("removes both the Connection source and its saved browser grant", () =>
    Effect.gen(function* () {
      const entries = yield* Ref.make<ReadonlyArray<import("./credential-store").StoredConnectionCredential>>(
        [{ _tag: "Stored", connectionId: connectionId("linear/acme") }],
      );
      const grants = yield* Ref.make<ReadonlyArray<StoredCredential>>([stored("acme", storedToken(far))]);
      const store = make({
        stored: {
          load: Ref.get(grants),
          save: () => Effect.void,
          loadConnectionCredentials: Ref.get(entries),
          removeConnectionCredential: (id) =>
            Ref.update(entries, (current) => current.filter((entry) => entry.connectionId !== id)),
          removeCredential: (issueTracker, organization) =>
            Ref.update(grants, (current) =>
              current.filter(
                (entry) => entry.issueTracker !== issueTracker || entry.organization !== organization,
              ),
            ),
        },
      });
      yield* store.removeConnection(connectionId("linear/acme"));

      assert.deepStrictEqual(yield* Ref.get(entries), []);
      assert.deepStrictEqual(yield* Ref.get(grants), []);
    }),
  );
});

const storedToken = (expiresAtMillis: number, accessToken = "oauth-token"): StoredToken => ({
  accessToken: Redacted.make(accessToken),
  refreshToken: null,
  expiresAtMillis,
  scopes: ["read", "write"],
});

const stored = (organization: string, token: StoredToken): StoredCredential => ({
  issueTracker: "linear",
  organization,
  actorUserId: `bot-${organization}`,
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
      assert.deepStrictEqual(credential.identity, { organization: "acme", actorUserId: "bot-acme" });
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
      const credential = yield* store.bearerToken({ ...account, issueTracker: "github" });
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

  it.layer(CredentialLogProbe.captureLayer)("logging", (it) => {
    it.effect("logs that it resolved from the stored credential", () =>
      Effect.gen(function* () {
        const store = yield* CredentialStore;
        const logs = yield* capturingLogs(store.bearerToken(account));
        assert.isTrue(logs.some((log) => logMessageIncludes(log, "stored-oauth")));
      }).pipe(withStored([stored("acme", storedToken(far))])),
    );
  });
});

const oauthAccount = { ...account, oauthClientId: "client-1" };

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
    store: make({ stored, refresh }),
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
  it.layer(CredentialLogProbe.captureLayer)("logging", (it) => {
    it.effect("annotates nested refresh logs with the requesting account", () =>
      Effect.gen(function* () {
        const { store } = yield* harness({
          initial: [stored("acme", expiredWithRefresh())],
          onRefresh: () => Effect.succeed(rotatedToken()),
        });
        const logs = yield* capturingLogs(store.bearerToken(oauthAccount));
        const log = logs.find((candidate) =>
          logMessageIncludes(candidate, "refreshed the stored credential"),
        );
        assert.deepStrictEqual(log?.annotations, { account: "AUD" });
        assert.deepStrictEqual(log?.message, ["refreshed the stored credential", { organization: "acme" }]);
      }).pipe(withRefreshEnv),
    );
  });

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
        stored: {
          load: Effect.succeed([stored("acme", expiredWithRefresh())]),
          save: () => Effect.void,
        },
      });
      const error = yield* Effect.flip(store.bearerToken(oauthAccount));
      assert.include(error.message, "no token refresh");
    }).pipe(withRefreshEnv),
  );
});

const requesting = {
  ...account,
  clientCredentials: { clientId: "client-1", secretEnv: "LINEAR_CLIENT_SECRET" },
};

interface GrantCalls {
  readonly minted: Ref.Ref<ReadonlyArray<string>>;
  readonly forgotten: Ref.Ref<ReadonlyArray<string>>;
}

class ClientCredentialsGrantCalls extends Context.Service<ClientCredentialsGrantCalls, GrantCalls>()(
  "@cogwork/engine/credential-store.test/ClientCredentialsGrantCalls",
) {
  static readonly layer = Layer.effect(
    ClientCredentialsGrantCalls,
    Effect.all({
      minted: Ref.make<ReadonlyArray<string>>([]),
      forgotten: Ref.make<ReadonlyArray<string>>([]),
    }),
  );
}

const recordingGrant = (secret: string | null, calls: GrantCalls): ClientCredentialsGrant => ({
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
    return Ref.update(calls.minted, (accounts) => [...accounts, account.key]).pipe(
      Effect.map(() => Redacted.make(secret)),
    );
  },
  forget: (account) => Ref.update(calls.forgotten, (accounts) => [...accounts, account.key]),
});

const withGrant = (
  secret: string | null,
  credentials: ReadonlyArray<StoredCredential> = [],
  env: Record<string, string> = { LINEAR_API_KEY: "env-key" },
) =>
  Effect.provide(
    Layer.mergeAll(
      Layer.effect(
        CredentialStore,
        Effect.map(ClientCredentialsGrantCalls, (calls) =>
          make({
            stored: { load: Effect.succeed(credentials), save: () => Effect.void },
            clientCredentials: recordingGrant(secret, calls),
          }),
        ),
      ).pipe(Layer.provideMerge(ClientCredentialsGrantCalls.layer)),
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
    }).pipe(withGrant("app-token")),
  );

  it.effect("keeps using the env key for an account that never asked for client credentials", () =>
    Effect.gen(function* () {
      const store = yield* CredentialStore;
      const credential = yield* store.bearerToken(account);
      assert.strictEqual(credential.source, "env");
      assert.strictEqual(Redacted.value(credential.token), "env-key");
    }).pipe(withGrant("app-token")),
  );

  it.effect("lets a live stored token win over client credentials", () =>
    Effect.gen(function* () {
      const calls = yield* ClientCredentialsGrantCalls;
      const store = yield* CredentialStore;
      const credential = yield* store.bearerToken(requesting);
      assert.strictEqual(credential.source, "stored-oauth");
      assert.deepStrictEqual(yield* Ref.get(calls.minted), []);
    }).pipe(withGrant("app-token", [stored("acme", storedToken(far))])),
  );

  it.effect("surfaces the missing-secret error instead of quietly using the env key", () =>
    Effect.gen(function* () {
      const store = yield* CredentialStore;
      const error = yield* Effect.flip(store.bearerToken(requesting));
      assert.include(error.message, "LINEAR_CLIENT_SECRET");
    }).pipe(withGrant(null)),
  );

  it.layer(CredentialLogProbe.captureLayer)("logging", (it) => {
    it.effect("logs that it resolved from client credentials", () =>
      Effect.gen(function* () {
        const store = yield* CredentialStore;
        const logs = yield* capturingLogs(store.bearerToken(requesting));
        assert.isTrue(logs.some((log) => logMessageIncludes(log, "client-credentials")));
      }).pipe(withGrant("app-token")),
    );
  });

  it.effect("asks the grant to forget a rejected token", () =>
    Effect.gen(function* () {
      const calls = yield* ClientCredentialsGrantCalls;
      const store = yield* CredentialStore;
      yield* store.invalidate(requesting);
      assert.deepStrictEqual(yield* Ref.get(calls.forgotten), ["AUD"]);
    }).pipe(withGrant("app-token")),
  );

  it.effect("has nothing to forget when no client-credentials source is wired", () =>
    Effect.gen(function* () {
      const store = yield* CredentialStore;
      yield* store.invalidate(requesting);
    }).pipe(withEnv({})),
  );
});

const providerAccount = { provider: "anthropic", envVars: ["ANTHROPIC_API_KEY"] } as const;

const providerKey = (provider: string, key: string): StoredProviderKey => ({
  provider,
  key: Redacted.make(key),
});

const withProviderKeys = (keys: ReadonlyArray<StoredProviderKey>, env: Record<string, string> = {}) =>
  Effect.provide(
    Layer.mergeAll(
      Layer.succeed(
        CredentialStore,
        make({
          stored: {
            load: Effect.succeed([]),
            save: () => Effect.void,
            loadProviderKeys: Effect.succeed(keys),
          },
        }),
      ),
      ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
    ),
  );

describe("CredentialStore (provider keys)", () => {
  it.effect("resolves a stored key over the env var", () =>
    Effect.gen(function* () {
      const store = yield* CredentialStore;
      const credential = yield* store.providerKey(providerAccount);
      assert.strictEqual(credential.source, "stored-key");
      assert.strictEqual(Redacted.value(credential.key), "sk-stored");
    }).pipe(withProviderKeys([providerKey("anthropic", "sk-stored")], { ANTHROPIC_API_KEY: "sk-env" })),
  );

  it.effect("falls back to the env var when no key is stored", () =>
    Effect.gen(function* () {
      const store = yield* CredentialStore;
      const credential = yield* store.providerKey(providerAccount);
      assert.strictEqual(credential.source, "env");
      assert.strictEqual(Redacted.value(credential.key), "sk-env");
    }).pipe(withProviderKeys([], { ANTHROPIC_API_KEY: "sk-env" })),
  );

  it.effect("trims whitespace off an env-var key and ignores a blank one", () =>
    Effect.gen(function* () {
      const store = yield* CredentialStore;
      const credential = yield* store.providerKey({
        provider: "google",
        envVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
      });
      assert.strictEqual(credential.source, "env");
      assert.strictEqual(Redacted.value(credential.key), "sk-google");
    }).pipe(withProviderKeys([], { GEMINI_API_KEY: "  ", GOOGLE_API_KEY: "  sk-google  " })),
  );

  it.effect("never hands one provider's stored key to another", () =>
    Effect.gen(function* () {
      const store = yield* CredentialStore;
      const error = yield* Effect.flip(store.providerKey(providerAccount));
      assert.include(error.message, "ANTHROPIC_API_KEY");
    }).pipe(withProviderKeys([providerKey("openai", "sk-openai")])),
  );

  it.effect("fails naming the env vars when neither a stored key nor an env var is set", () =>
    Effect.gen(function* () {
      const store = yield* CredentialStore;
      const error = yield* Effect.flip(
        store.providerKey({ provider: "google", envVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"] }),
      );
      assert.strictEqual(error.account, "google");
      assert.include(error.message, "GEMINI_API_KEY or GOOGLE_API_KEY");
    }).pipe(withProviderKeys([])),
  );

  it.layer(CredentialLogProbe.captureLayer)("logging", (it) => {
    it.effect("logs the source a provider key resolved from", () =>
      Effect.gen(function* () {
        const store = yield* CredentialStore;
        const logs = yield* capturingLogs(store.providerKey(providerAccount));
        assert.isTrue(
          logs.some((log) => logMessageIncludes(log, "stored-key") && logMessageIncludes(log, "anthropic")),
        );
      }).pipe(withProviderKeys([providerKey("anthropic", "sk-stored")])),
    );
  });

  it.effect("persists a provider key through the wired store", () =>
    Effect.gen(function* () {
      const saved: Array<StoredProviderKey> = [];
      const store = make({
        stored: {
          load: Effect.succeed([]),
          save: () => Effect.void,
          saveProviderKey: (key) => Effect.sync(() => void saved.push(key)),
        },
      });
      yield* store.persistProviderKey(providerKey("openrouter", "sk-or-1"));
      assert.strictEqual(saved.length, 1);
      assert.strictEqual(saved[0] && Redacted.value(saved[0].key), "sk-or-1");
    }),
  );

  it.effect("fails to persist when the store cannot save provider keys", () =>
    Effect.gen(function* () {
      const store = make({ stored: { load: Effect.succeed([]), save: () => Effect.void } });
      const error = yield* Effect.flip(store.persistProviderKey(providerKey("openrouter", "sk-or-1")));
      assert.include(error.message, "cannot persist provider keys");
    }),
  );
});
