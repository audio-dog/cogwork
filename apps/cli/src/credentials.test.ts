import { CredentialStore } from "@clanker-forge/engine";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { makeFileStore } from "./credentials";

const stored = (accessToken: string, expiresAtMillis = Number.MAX_SAFE_INTEGER) =>
  ({
    workSource: "linear",
    organization: "acme",
    botUserId: "bot-user",
    token: {
      accessToken: Redacted.make(accessToken),
      refreshToken: Redacted.make("refresh-token"),
      expiresAtMillis,
      scopes: ["read", "write"],
    },
  }) satisfies CredentialStore.StoredCredential;

const account: CredentialStore.CredentialAccount = {
  key: "AUD",
  workSource: "linear",
  organization: "acme",
  tokenEnv: "LINEAR_API_KEY",
  clientCredentials: null,
};

const onDisk = <A, E>(
  use: (paths: {
    readonly filePath: string;
    readonly fs: FileSystem.FileSystem;
  }) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "clanker-forge-credentials-" });
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
          botUserId: "bot-user",
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
        yield* seed(fs, filePath, `{"version":1,"credentials":[{"workSource":"linear"}]}`);
        const store = CredentialStore.make({ stored: yield* makeFileStore(filePath) });
        const credential = yield* store.bearerToken(account);
        assert.strictEqual(credential.source, "env");
      }),
    ),
  );
});
