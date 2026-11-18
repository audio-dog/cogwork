import { type ConnectionId, connectionAccountOf, connectionSystemOf } from "@cogwork/contracts";
import { CredentialStore, GitHub, Linear } from "@cogwork/engine";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { makeTokenRefresh as makeGranolaTokenRefresh } from "./granola-login";
import { makeTokenRefresh as makeSlackTokenRefresh } from "./slack-login";

const fileMode = 0o600;
const directoryMode = 0o700;

// Schema issues and platform errors quote the input that failed, which here is a secret (an access
// token or an api key), so nothing below may put a cause message into a log line or a CredentialError.
const decodeFile = Schema.decodeUnknownEffect(Schema.fromJsonString(CredentialStore.CredentialFileWire));
const encodeFile = Schema.encodeEffect(Schema.fromJsonString(CredentialStore.CredentialFile));

const emptyContents: CredentialStore.CredentialFileContents = {
  credentials: [],
  providerKeys: [],
  connectionCredentials: [],
};

export const makeFileStore = Effect.fn("credentials.file")(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.dirname(filePath);
  const pendingPath = `${filePath}.pending`;
  const writeGate = yield* Semaphore.make(1);

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
      version: 3,
      credentials: contents.credentials,
      providerKeys: contents.providerKeys,
      connectionCredentials: contents.connectionCredentials,
    }).pipe(
      Effect.mapError(
        () =>
          new CredentialStore.CredentialError({
            account,
            message: `could not serialize ${filePath}`,
            retryable: false,
          }),
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
            retryable: false,
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
        retryable: false,
      });
    }
    return contents;
  });

  const update = Effect.fn("credentials.update")(function* (
    account: string,
    change: (contents: CredentialStore.CredentialFileContents) => CredentialStore.CredentialFileContents,
  ) {
    return yield* writeGate.withPermit(
      Effect.gen(function* () {
        const contents = yield* readForWrite(account);
        yield* write(account, change(contents));
      }),
    );
  });

  const save = Effect.fn("credentials.save")(function* (credential: CredentialStore.StoredCredential) {
    const account = CredentialStore.accountOf(credential);
    yield* update(account, (contents) => ({
      ...contents,
      credentials: [
        ...contents.credentials.filter((entry) => CredentialStore.accountOf(entry) !== account),
        credential,
      ],
    }));
  });

  const saveProviderKey = Effect.fn("credentials.saveProviderKey")(function* (
    key: CredentialStore.StoredProviderKey,
  ) {
    yield* update(key.provider, (contents) => ({
      ...contents,
      providerKeys: [...contents.providerKeys.filter((entry) => entry.provider !== key.provider), key],
    }));
  });

  const saveConnectionCredential = Effect.fn("credentials.saveConnectionCredential")(function* (
    credential: CredentialStore.StoredConnectionCredential,
  ) {
    yield* update(credential.connectionId, (contents) => {
      const preservesGranolaLogin =
        credential._tag === "ApiKey" && connectionSystemOf(credential.connectionId) === "granola";
      const others = contents.connectionCredentials.filter(
        (entry) =>
          entry.connectionId !== credential.connectionId ||
          (preservesGranolaLogin && entry._tag === "Stored"),
      );
      return { ...contents, connectionCredentials: [...others, credential] };
    });
  });

  const removeConnectionCredential = Effect.fn("credentials.removeConnectionCredential")(function* (
    connectionId: string,
  ) {
    yield* update(connectionId, (contents) => ({
      ...contents,
      connectionCredentials: contents.connectionCredentials.filter(
        (entry) => entry.connectionId !== connectionId,
      ),
    }));
  });

  const removeCredential = Effect.fn("credentials.removeCredential")(function* (
    issueTracker: string,
    organization: string,
  ) {
    const account = `${issueTracker}/${organization}`;
    yield* update(account, (contents) => ({
      ...contents,
      credentials: contents.credentials.filter(
        (entry) => entry.issueTracker !== issueTracker || entry.organization !== organization,
      ),
    }));
  });

  const removeConnection = Effect.fn("credentials.removeConnection")(function* (connectionId: ConnectionId) {
    const system = connectionSystemOf(connectionId);
    const account = connectionAccountOf(connectionId);
    yield* update(connectionId, (contents) => ({
      ...contents,
      credentials: contents.credentials.filter(
        (entry) => entry.issueTracker !== system || entry.organization !== account,
      ),
      connectionCredentials: contents.connectionCredentials.filter(
        (entry) => entry.connectionId !== connectionId,
      ),
    }));
  });

  return {
    load: Effect.map(read(), (contents) => contents?.credentials ?? []),
    save,
    loadProviderKeys: Effect.map(read(), (contents) => contents?.providerKeys ?? []),
    saveProviderKey,
    loadConnectionCredentials: Effect.map(read(), (contents) => contents?.connectionCredentials ?? []),
    saveConnectionCredential,
    removeConnectionCredential,
    removeCredential,
    removeConnection,
  } satisfies CredentialStore.StoredCredentials;
});

export const layer = (filePath: string) =>
  Layer.effect(
    CredentialStore.CredentialStore,
    Effect.gen(function* () {
      const stored = yield* makeFileStore(filePath);
      const client = yield* HttpClient.HttpClient;
      const spawner = yield* ChildProcessSpawner;
      const clientCredentials = yield* Linear.ClientCredentials.make();
      const githubCli = yield* GitHub.makeCliCredentialSource(spawner);
      const refreshers: Record<string, CredentialStore.TokenRefresh> = {
        linear: Linear.OAuth.makeTokenRefresh(client),
        granola: makeGranolaTokenRefresh(client),
        slack: makeSlackTokenRefresh(client),
      };
      return CredentialStore.make({
        stored,
        clientCredentials,
        githubCli,
        refresh: (request) =>
          refreshers[request.issueTracker]?.(request) ??
          Effect.fail(
            new CredentialStore.CredentialError({
              account: request.account,
              message: `cannot refresh the stored token for ${request.account}`,
              retryable: false,
            }),
          ),
      });
    }),
  );
