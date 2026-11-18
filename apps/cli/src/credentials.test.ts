import { connectionIdOf } from "@cogwork/contracts";
import { CredentialStore } from "@cogwork/engine";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { layer, makeFileStore } from "./credentials";

const stored = (accessToken: string, expiresAtMillis = Number.MAX_SAFE_INTEGER) =>
  ({
    issueTracker: "linear",
    organization: "acme",
    actorUserId: "bot-user",
    token: {
      accessToken: Redacted.make(accessToken),
      refreshToken: Redacted.make("refresh-token"),
      expiresAtMillis,
      scopes: ["read", "write"],
    },
  }) satisfies CredentialStore.StoredCredential;

const account: CredentialStore.CredentialAccount = {
  key: "AUD",
  issueTracker: "linear",
  organization: "acme",
  tokenEnv: "LINEAR_API_KEY",
  clientCredentials: null,
  oauthClientId: null,
};

const providerAccount: CredentialStore.ProviderAccount = {
  provider: "anthropic",
  envVars: ["ANTHROPIC_API_KEY"],
};

const providerKey = (provider: string, key: string): CredentialStore.StoredProviderKey => ({
  provider,
  key: Redacted.make(key),
});

const tokenEndpoint: typeof globalThis.fetch = () =>
  Promise.resolve(
    new Response(
      JSON.stringify({
        access_token: "rotated-token",
        token_type: "Bearer",
        expires_in: 86_400,
        scope: "read write",
        refresh_token: "rotated-refresh",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );

const onDisk = <A, E>(
  use: (paths: {
    readonly filePath: string;
    readonly fs: FileSystem.FileSystem;
  }) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-credentials-" });
    return yield* use({ filePath: path.join(dir, "nested", "credentials.json"), fs });
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: { LINEAR_API_KEY: "env-key" } })),
      ),
    ),
  );

const seed = Effect.fn("seed")(function* (
  fs: FileSystem.FileSystem,
  filePath: string,
  contents: string,
  mode?: number,
) {
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
  yield* fs.writeFileString(filePath, contents, mode === undefined ? undefined : { mode });
});

describe("file-backed credential store", () => {
  it.effect("round-trips a saved credential and prefers it over the env key", () =>
    onDisk(({ filePath }) =>
      Effect.gen(function* () {
        const store = CredentialStore.make({ stored: yield* makeFileStore(filePath) });
        yield* store.persist(stored("oauth-token"));
        const credential = yield* store.bearerToken(account);
        assert.strictEqual(credential.source, "stored-oauth");
        assert.strictEqual(Redacted.value(credential.token), "oauth-token");
        assert.deepStrictEqual(credential.identity, {
          organization: "acme",
          actorUserId: "bot-user",
        });
      }),
    ),
  );

  it.effect("writes the credential file with 0600 permissions", () =>
    onDisk(({ filePath, fs }) =>
      Effect.gen(function* () {
        const file = yield* makeFileStore(filePath);
        yield* file.save(stored("oauth-token"));
        const info = yield* fs.stat(filePath);
        assert.strictEqual(info.mode & 0o777, 0o600);
      }),
    ),
  );

  it.effect("persists a GitHub CLI source marker without a token", () =>
    onDisk(({ filePath, fs }) =>
      Effect.gen(function* () {
        const file = yield* makeFileStore(filePath);
        const connectionId = connectionIdOf("github", "octocat");
        yield* file.saveConnectionCredential?.({ _tag: "GitHubCli", connectionId });

        assert.deepStrictEqual(yield* file.loadConnectionCredentials, [{ _tag: "GitHubCli", connectionId }]);
        const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(CredentialStore.CredentialFile))(
          yield* fs.readFileString(filePath),
        );
        assert.deepStrictEqual(decoded, {
          version: 3,
          credentials: [],
          providerKeys: [],
          connectionCredentials: [{ _tag: "GitHubCli", connectionId }],
        });
      }),
    ),
  );

  it.effect("keeps OAuth and API key secrets for one Connection", () =>
    onDisk(({ filePath }) =>
      Effect.gen(function* () {
        const file = yield* makeFileStore(filePath);
        const connectionId = connectionIdOf("granola", "person@example.com");

        yield* file.saveConnectionCredential?.({ _tag: "Stored", connectionId });
        yield* file.saveConnectionCredential?.({
          _tag: "ApiKey",
          connectionId,
          key: Redacted.make("grn_secret"),
        });
        yield* file.save({
          issueTracker: "granola",
          organization: "person@example.com",
          actorUserId: "person@example.com",
          oauthClientId: "granola-client",
          token: {
            accessToken: Redacted.make("revoked-token"),
            refreshToken: Redacted.make("revoked-refresh"),
            expiresAtMillis: 0,
            scopes: ["mcp"],
          },
        });

        const credentials = yield* file.loadConnectionCredentials ?? Effect.succeed([]);
        assert.deepStrictEqual(
          credentials.map((credential) => credential._tag),
          ["Stored", "ApiKey"],
        );
        const store = CredentialStore.make({ stored: file });
        const credential = yield* store.bearerToken({
          connectionId,
          key: connectionId,
          issueTracker: "granola",
          organization: "person@example.com",
          tokenEnv: "GRANOLA_API_KEY",
          clientCredentials: null,
          oauthClientId: null,
        });
        assert.strictEqual(credential.source, "stored-key");
        assert.strictEqual(Redacted.value(credential.token), "grn_secret");
      }),
    ),
  );

  it.effect("serializes writes across credential kinds", () =>
    onDisk(({ filePath }) =>
      Effect.gen(function* () {
        const file = yield* makeFileStore(filePath);
        const connectionId = connectionIdOf("slack", "T-STUB");
        yield* Effect.all(
          [
            file.save({
              issueTracker: "slack",
              organization: "T-STUB",
              actorUserId: "U-STUB",
              token: {
                accessToken: Redacted.make("slack-access"),
                refreshToken: Redacted.make("slack-refresh"),
                expiresAtMillis: Number.MAX_SAFE_INTEGER,
                scopes: ["channels:history"],
              },
            }),
            file.saveProviderKey?.(providerKey("anthropic", "provider-key")) ?? Effect.void,
            file.saveConnectionCredential?.({ _tag: "Stored", connectionId }) ?? Effect.void,
          ],
          { concurrency: "unbounded" },
        );

        assert.strictEqual((yield* file.load).length, 1);
        assert.strictEqual((yield* file.loadProviderKeys ?? Effect.succeed([])).length, 1);
        assert.strictEqual((yield* file.loadConnectionCredentials ?? Effect.succeed([])).length, 1);
      }),
    ),
  );

  it.effect("removes a Connection source and browser grant in one write", () =>
    onDisk(({ filePath }) =>
      Effect.gen(function* () {
        const file = yield* makeFileStore(filePath);
        const connectionId = connectionIdOf("slack", "T-STUB");
        yield* file.save({
          issueTracker: "slack",
          organization: "T-STUB",
          actorUserId: "U-STUB",
          token: {
            accessToken: Redacted.make("slack-access"),
            refreshToken: Redacted.make("slack-refresh"),
            expiresAtMillis: Number.MAX_SAFE_INTEGER,
            scopes: ["channels:history"],
          },
        });
        yield* file.saveConnectionCredential?.({ _tag: "Stored", connectionId });

        yield* CredentialStore.make({ stored: file }).removeConnection(connectionId);

        assert.deepStrictEqual(yield* file.load, []);
        assert.deepStrictEqual(yield* file.loadConnectionCredentials, []);
      }),
    ),
  );

  it.effect("browser login replaces a Connection's previous source", () =>
    onDisk(({ filePath }) =>
      Effect.gen(function* () {
        const file = yield* makeFileStore(filePath);
        const save = file.saveConnectionCredential;
        if (!save) return assert.fail("Expected Connection credential persistence");
        const linearId = connectionIdOf("linear", "acme");
        const granolaId = connectionIdOf("granola", "person@example.com");

        yield* Effect.forEach([linearId, granolaId], (connectionId) =>
          save({ _tag: "ApiKey", connectionId, key: Redacted.make("old-key") }).pipe(
            Effect.andThen(save({ _tag: "Stored", connectionId })),
          ),
        );

        assert.deepStrictEqual(yield* file.loadConnectionCredentials, [
          { _tag: "Stored", connectionId: linearId },
          { _tag: "Stored", connectionId: granolaId },
        ]);
      }),
    ),
  );

  it.effect("tightens the permissions of an existing world-readable file", () =>
    onDisk(({ filePath, fs }) =>
      Effect.gen(function* () {
        yield* seed(fs, filePath, `{"version":1,"credentials":[]}`, 0o644);
        const file = yield* makeFileStore(filePath);
        yield* file.save(stored("oauth-token"));
        const info = yield* fs.stat(filePath);
        assert.strictEqual(info.mode & 0o777, 0o600);
      }),
    ),
  );

  it.effect("leaves no pending file behind after a save", () =>
    onDisk(({ filePath, fs }) =>
      Effect.gen(function* () {
        const file = yield* makeFileStore(filePath);
        yield* file.save(stored("oauth-token"));
        assert.isFalse(yield* fs.exists(`${filePath}.pending`));
      }),
    ),
  );

  it.effect("replaces the entry for an account instead of appending a duplicate", () =>
    onDisk(({ filePath }) =>
      Effect.gen(function* () {
        const file = yield* makeFileStore(filePath);
        yield* file.save(stored("first-token"));
        yield* file.save(stored("second-token"));
        const credentials = yield* file.load;
        assert.deepStrictEqual(
          credentials.map((entry) => Redacted.value(entry.token.accessToken)),
          ["second-token"],
        );
      }),
    ),
  );

  it.effect("keeps other organizations when saving one", () =>
    onDisk(({ filePath }) =>
      Effect.gen(function* () {
        const file = yield* makeFileStore(filePath);
        yield* file.save({ ...stored("acme-token"), organization: "acme" });
        yield* file.save({ ...stored("other-token"), organization: "other" });
        const credentials = yield* file.load;
        assert.deepStrictEqual(
          credentials.map((entry) => entry.organization),
          ["acme", "other"],
        );
      }),
    ),
  );

  it.effect("refuses to overwrite a credential file it cannot read", () =>
    onDisk(({ filePath, fs }) =>
      Effect.gen(function* () {
        yield* seed(fs, filePath, "{ not json");
        const file = yield* makeFileStore(filePath);
        const error = yield* Effect.flip(file.save(stored("oauth-token")));
        assert.include(error.message, "refusing to overwrite");
        assert.strictEqual(yield* fs.readFileString(filePath), "{ not json");
      }),
    ),
  );

  it.effect("keeps the access token out of the error it reports", () =>
    onDisk(({ filePath, fs }) =>
      Effect.gen(function* () {
        yield* seed(fs, filePath, "{ not json");
        const file = yield* makeFileStore(filePath);
        const error = yield* Effect.flip(file.save(stored("super-secret-token")));
        assert.notInclude(`${error.account} ${error.message}`, "super-secret-token");
      }),
    ),
  );

  it.effect("falls back to the env key when the file is absent", () =>
    onDisk(({ filePath }) =>
      Effect.gen(function* () {
        const store = CredentialStore.make({ stored: yield* makeFileStore(filePath) });
        const credential = yield* store.bearerToken(account);
        assert.strictEqual(credential.source, "env");
        assert.strictEqual(Redacted.value(credential.token), "env-key");
      }),
    ),
  );

  it.effect("falls back to the env key when the file is malformed", () =>
    onDisk(({ filePath, fs }) =>
      Effect.gen(function* () {
        yield* seed(fs, filePath, "{ not json");
        const store = CredentialStore.make({ stored: yield* makeFileStore(filePath) });
        const credential = yield* store.bearerToken(account);
        assert.strictEqual(credential.source, "env");
      }),
    ),
  );

  it.effect("falls back to the env key when the file has the wrong shape", () =>
    onDisk(({ filePath, fs }) =>
      Effect.gen(function* () {
        yield* seed(fs, filePath, `{"version":1,"credentials":[{"issueTracker":"linear"}]}`);
        const store = CredentialStore.make({ stored: yield* makeFileStore(filePath) });
        const credential = yield* store.bearerToken(account);
        assert.strictEqual(credential.source, "env");
      }),
    ),
  );

  it.effect("round-trips a saved provider key and resolves it over the env var", () =>
    onDisk(({ filePath }) =>
      Effect.gen(function* () {
        const store = CredentialStore.make({ stored: yield* makeFileStore(filePath) });
        yield* store.persistProviderKey(providerKey("anthropic", "sk-ant-stored"));
        const credential = yield* store.providerKey(providerAccount);
        assert.strictEqual(credential.source, "stored-key");
        assert.strictEqual(Redacted.value(credential.key), "sk-ant-stored");
      }),
    ),
  );

  it.effect("keeps issue-tracker credentials when saving a provider key", () =>
    onDisk(({ filePath }) =>
      Effect.gen(function* () {
        const file = yield* makeFileStore(filePath);
        yield* file.save(stored("oauth-token"));
        yield* file.saveProviderKey?.(providerKey("openai", "sk-openai"));
        const credentials = yield* file.load;
        const keys = yield* file.loadProviderKeys ?? Effect.succeed([]);
        assert.strictEqual(credentials.length, 1);
        assert.deepStrictEqual(
          keys.map((entry) => entry.provider),
          ["openai"],
        );
      }),
    ),
  );

  it.effect("upgrades a v1 file in place when the first provider key is saved", () =>
    onDisk(({ filePath, fs }) =>
      Effect.gen(function* () {
        yield* seed(fs, filePath, `{"version":1,"credentials":[]}`);
        const file = yield* makeFileStore(filePath);
        yield* file.saveProviderKey?.(providerKey("google", "sk-gem"));
        const keys = yield* file.loadProviderKeys ?? Effect.succeed([]);
        assert.deepStrictEqual(
          keys.map((entry) => Redacted.value(entry.key)),
          ["sk-gem"],
        );
      }),
    ),
  );

  it.effect("replaces the key for a provider instead of appending a duplicate", () =>
    onDisk(({ filePath }) =>
      Effect.gen(function* () {
        const file = yield* makeFileStore(filePath);
        yield* file.saveProviderKey?.(providerKey("anthropic", "sk-first"));
        yield* file.saveProviderKey?.(providerKey("anthropic", "sk-second"));
        const keys = yield* file.loadProviderKeys ?? Effect.succeed([]);
        assert.deepStrictEqual(
          keys.map((entry) => Redacted.value(entry.key)),
          ["sk-second"],
        );
      }),
    ),
  );

  it.effect("keeps a provider key out of the error when the file cannot be read", () =>
    onDisk(({ filePath, fs }) =>
      Effect.gen(function* () {
        yield* seed(fs, filePath, "{ not json");
        const file = yield* makeFileStore(filePath);
        const error = yield* Effect.flip(
          file.saveProviderKey?.(providerKey("anthropic", "super-secret-key")) ?? Effect.void,
        );
        assert.notInclude(`${error.account} ${error.message}`, "super-secret-key");
      }),
    ),
  );

  it.effect("refreshes an expired stored token through the wired layer and rewrites the file", () =>
    onDisk(({ filePath }) =>
      Effect.gen(function* () {
        const file = yield* makeFileStore(filePath);
        yield* file.save(stored("stale-token", 0));
        const store = yield* CredentialStore.CredentialStore;
        const credential = yield* store.bearerToken({ ...account, oauthClientId: "client-1" });
        assert.strictEqual(credential.source, "stored-oauth");
        assert.strictEqual(Redacted.value(credential.token), "rotated-token");
        const saved = (yield* file.load)[0]?.token;
        assert.strictEqual(saved && Redacted.value(saved.accessToken), "rotated-token");
        assert.strictEqual(saved?.refreshToken && Redacted.value(saved.refreshToken), "rotated-refresh");
      }).pipe(
        Effect.provide(Layer.provide(layer(filePath), FetchHttpClient.layer)),
        Effect.provideService(FetchHttpClient.Fetch, tokenEndpoint),
      ),
    ),
  );

  it.effect("stores Slack's rotated refresh token", () =>
    onDisk(({ filePath }) => {
      const requests: Array<URLSearchParams> = [];
      const endpoint: typeof globalThis.fetch = (input, init) => {
        const request = new Request(input, init);
        return request.text().then((body) => {
          requests.push(new URLSearchParams(body));
          return new Response(
            JSON.stringify({
              ok: true,
              access_token: "slack-rotated",
              refresh_token: "slack-refresh-2",
              expires_in: 43_200,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        });
      };
      return Effect.gen(function* () {
        const file = yield* makeFileStore(filePath);
        yield* file.save({
          issueTracker: "slack",
          organization: "T-STUB",
          actorUserId: "U-STUB",
          oauthClientId: "slack-client",
          oauthTokenEndpoint: "https://slack.example/token",
          token: {
            accessToken: Redacted.make("slack-stale"),
            refreshToken: Redacted.make("slack-refresh-1"),
            expiresAtMillis: 0,
            scopes: ["channels:history"],
          },
        });
        const store = yield* CredentialStore.CredentialStore;
        const result = yield* Effect.result(
          store.bearerToken({
            key: "slack/T-STUB",
            issueTracker: "slack",
            organization: "T-STUB",
            tokenEnv: "SLACK_TOKEN",
            clientCredentials: null,
            oauthClientId: null,
          }),
        );
        assert.isTrue(Result.isSuccess(result));
        if (Result.isFailure(result)) return;
        const credential = result.success;
        const saved = (yield* file.load)[0]?.token;

        assert.strictEqual(Redacted.value(credential.token), "slack-rotated");
        assert.strictEqual(saved?.refreshToken && Redacted.value(saved.refreshToken), "slack-refresh-2");
        assert.deepStrictEqual(saved?.scopes, []);
        assert.strictEqual(requests[0]?.get("client_secret"), null);
        assert.strictEqual(requests[0]?.get("refresh_token"), "slack-refresh-1");
      }).pipe(
        Effect.provide(Layer.provide(layer(filePath), FetchHttpClient.layer)),
        Effect.provideService(FetchHttpClient.Fetch, endpoint),
      );
    }),
  );
});
