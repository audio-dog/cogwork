import { CredentialStore, Linear } from "@clanker-forge/engine";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";

const fileMode = 0o600;
const directoryMode = 0o700;

// Schema issues and platform errors quote the input that failed, which here is the access token
// itself, so nothing below may put a cause message into a log line or a CredentialError.
const CredentialFileJson = Schema.fromJsonString(CredentialStore.CredentialFile);
const decodeFile = Schema.decodeUnknownEffect(CredentialFileJson);
const encodeFile = Schema.encodeEffect(CredentialFileJson);

const emptyFile: CredentialStore.CredentialFile = { version: 1, credentials: [] };

export const makeFileStore = Effect.fn("credentials.file")(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.dirname(filePath);
  const pendingPath = `${filePath}.pending`;

  const read = Effect.fn("credentials.read")(function* () {
    const present = yield* Effect.orElseSucceed(fs.exists(filePath), () => false);
    if (!present) return emptyFile;
    return yield* fs.readFileString(filePath).pipe(
      Effect.flatMap(decodeFile),
      Effect.tapError(() => Effect.logWarning("ignoring unreadable credential file", { path: filePath })),
      Effect.orElseSucceed(() => null),
    );
  });

  // Renaming a freshly created 0600 file is what keeps the token off disk in a readable mode: the
  // `mode` option is ignored when the destination already exists, and an interrupted in-place write
  // would truncate every other stored credential.
  const write = Effect.fn("credentials.write")(function* (
    account: string,
    credentials: ReadonlyArray<CredentialStore.StoredCredential>,
  ) {
    const contents = yield* Effect.orDie(encodeFile({ version: 1, credentials }));
    yield* fs.makeDirectory(directory, { recursive: true, mode: directoryMode }).pipe(
      Effect.andThen(fs.writeFileString(pendingPath, contents, { flag: "w", mode: fileMode })),
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

  const save = Effect.fn("credentials.save")(function* (credential: CredentialStore.StoredCredential) {
    const account = CredentialStore.accountOf(credential);
    const file = yield* read();
    if (file === null) {
      return yield* new CredentialStore.CredentialError({
        account,
        message: `${filePath} could not be read; refusing to overwrite it`,
      });
    }
    const others = file.credentials.filter((entry) => CredentialStore.accountOf(entry) !== account);
    yield* write(account, [...others, credential]);
  });

  return {
    load: Effect.map(read(), (file) => file?.credentials ?? []),
    save,
  } satisfies CredentialStore.StoredCredentials;
});

export const layer = (filePath: string) =>
  Layer.effect(
    CredentialStore.CredentialStore,
    Effect.gen(function* () {
      const stored = yield* makeFileStore(filePath);
      const client = yield* HttpClient.HttpClient;
      return CredentialStore.make(stored, Linear.OAuth.makeTokenRefresh(client));
    }),
  );
