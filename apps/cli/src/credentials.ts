import { CredentialStore, Linear } from "@clanker-forge/engine";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";

const fileMode = 0o600;
const directoryMode = 0o700;

// Schema issues and platform errors quote the input that failed, which here is a secret (an access
// token or an api key), so nothing below may put a cause message into a log line or a CredentialError.
const decodeFile = Schema.decodeUnknownEffect(Schema.fromJsonString(CredentialStore.CredentialFileWire));
const encodeFile = Schema.encodeEffect(Schema.fromJsonString(CredentialStore.CredentialFile));

const emptyContents: CredentialStore.CredentialFileContents = { credentials: [], providerKeys: [] };

export const makeFileStore = Effect.fn("credentials.file")(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.dirname(filePath);
  const pendingPath = `${filePath}.pending`;

  const read = Effect.fn("credentials.read")(function* () {
    const present = yield* Effect.orElseSucceed(fs.exists(filePath), () => false);
    if (!present) return emptyContents;
    return yield* fs.readFileString(filePath).pipe(
      Effect.flatMap(decodeFile),
      Effect.map(CredentialStore.contentsOf),
      Effect.tapError(() => Effect.logWarning("ignoring unreadable credential file", { path: filePath })),
      Effect.orElseSucceed(() => null),
    );
  });

  // Renaming a freshly created 0600 file is what keeps the secret off disk in a readable mode: the
  // `mode` option is ignored when the destination already exists, and an interrupted in-place write
  // would truncate every other stored credential.
  const write = Effect.fn("credentials.write")(function* (
    account: string,
    contents: CredentialStore.CredentialFileContents,
  ) {
    const encoded = yield* encodeFile({
      version: 2,
      credentials: contents.credentials,
      providerKeys: contents.providerKeys,
    }).pipe(
      Effect.mapError(
        () => new CredentialStore.CredentialError({ account, message: `could not serialize ${filePath}` }),
      ),
    );
    yield* fs.makeDirectory(directory, { recursive: true, mode: directoryMode }).pipe(
      Effect.andThen(fs.writeFileString(pendingPath, encoded, { flag: "w", mode: fileMode })),
      Effect.andThen(fs.chmod(pendingPath, fileMode)),
      Effect.andThen(fs.rename(pendingPath, filePath)),
      Effect.mapError(
        (cause) =>
          new CredentialStore.CredentialError({
            account,
            message: `could not write ${filePath} (${cause.reason._tag})`,
          }),
      ),
    );
  });

  const readForWrite = Effect.fn("credentials.readForWrite")(function* (account: string) {
    const contents = yield* read();
    if (contents === null) {
      return yield* new CredentialStore.CredentialError({
        account,
        message: `${filePath} could not be read; refusing to overwrite it`,
      });
    }
    return contents;
  });

  const save = Effect.fn("credentials.save")(function* (credential: CredentialStore.StoredCredential) {
    const account = CredentialStore.accountOf(credential);
    const contents = yield* readForWrite(account);
    const others = contents.credentials.filter((entry) => CredentialStore.accountOf(entry) !== account);
    yield* write(account, { ...contents, credentials: [...others, credential] });
  });

  const saveProviderKey = Effect.fn("credentials.saveProviderKey")(function* (
    key: CredentialStore.StoredProviderKey,
  ) {
    const contents = yield* readForWrite(key.provider);
    const others = contents.providerKeys.filter((entry) => entry.provider !== key.provider);
    yield* write(key.provider, { ...contents, providerKeys: [...others, key] });
  });

  return {
    load: Effect.map(read(), (contents) => contents?.credentials ?? []),
    save,
    loadProviderKeys: Effect.map(read(), (contents) => contents?.providerKeys ?? []),
    saveProviderKey,
  } satisfies CredentialStore.StoredCredentials;
});

export const layer = (filePath: string) =>
  Layer.effect(
    CredentialStore.CredentialStore,
    Effect.gen(function* () {
      const stored = yield* makeFileStore(filePath);
      const client = yield* HttpClient.HttpClient;
      const clientCredentials = yield* Linear.ClientCredentials.make();
      return CredentialStore.make({
        stored,
        clientCredentials,
        refresh: Linear.OAuth.makeTokenRefresh(client),
      });
    }),
  );
