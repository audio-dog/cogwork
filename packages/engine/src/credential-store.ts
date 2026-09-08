import {
  ConnectionId,
  ConnectionSource,
  connectionAccountOf,
  connectionSystemOf,
  TrimmedNonEmptyString,
} from "@cogwork/contracts";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

// Naming the secret's env var is how an operator asks for the client-credentials source at all: an
// OAuth app configured for browser login alone leaves it unset and keeps the legacy env-key floor.
export interface ClientCredentialsRef {
  readonly clientId: string;
  readonly secretEnv: string;
}

export interface CredentialAccount {
  readonly connectionId?: ConnectionId;
  readonly key: string;
  readonly issueTracker: string;
  readonly organization: string | null;
  readonly tokenEnv: string;
  readonly clientCredentials: ClientCredentialsRef | null;
  readonly oauthClientId: string | null;
}

export class CredentialError extends Schema.TaggedError<CredentialError>()("CredentialError", {
  account: Schema.String,
  message: Schema.String,
}) {}

export const StoredToken = Schema.Struct({
  accessToken: Schema.RedactedFromValue(TrimmedNonEmptyString),
  refreshToken: Schema.NullOr(Schema.RedactedFromValue(TrimmedNonEmptyString)),
  expiresAtMillis: Schema.Finite,
  scopes: Schema.Array(TrimmedNonEmptyString),
});
export type StoredToken = typeof StoredToken.Type;

export const StoredCredential = Schema.Struct({
  issueTracker: TrimmedNonEmptyString,
  organization: TrimmedNonEmptyString,
  actorUserId: TrimmedNonEmptyString,
  oauthClientId: Schema.optional(TrimmedNonEmptyString),
  token: StoredToken,
});
export type StoredCredential = typeof StoredCredential.Type;

export const StoredProviderKey = Schema.Struct({
  provider: TrimmedNonEmptyString,
  key: Schema.RedactedFromValue(TrimmedNonEmptyString),
});
export type StoredProviderKey = typeof StoredProviderKey.Type;

export const StoredConnectionCredential = Schema.TaggedUnion({
  Stored: {
    connectionId: ConnectionId,
  },
  Env: {
    connectionId: ConnectionId,
    name: TrimmedNonEmptyString,
  },
  ApiKey: {
    connectionId: ConnectionId,
    key: Schema.RedactedFromValue(TrimmedNonEmptyString),
  },
  GitHubCli: {
    connectionId: ConnectionId,
  },
});
export type StoredConnectionCredential = typeof StoredConnectionCredential.Type;

const CredentialFileV1 = Schema.Struct({
  version: Schema.Literal(1),
  credentials: Schema.Array(StoredCredential),
});

const CredentialFileV2 = Schema.Struct({
  version: Schema.Literal(2),
  credentials: Schema.Array(StoredCredential),
  providerKeys: Schema.Array(StoredProviderKey),
});

export const CredentialFile = Schema.Struct({
  version: Schema.Literal(3),
  credentials: Schema.Array(StoredCredential),
  providerKeys: Schema.Array(StoredProviderKey),
  connectionCredentials: Schema.Array(StoredConnectionCredential),
});
export type CredentialFile = typeof CredentialFile.Type;

export const CredentialFileWire = Schema.Union([CredentialFile, CredentialFileV2, CredentialFileV1]);
export type CredentialFileWire = typeof CredentialFileWire.Type;

export interface CredentialFileContents {
  readonly credentials: ReadonlyArray<StoredCredential>;
  readonly providerKeys: ReadonlyArray<StoredProviderKey>;
  readonly connectionCredentials: ReadonlyArray<StoredConnectionCredential>;
}

export const contentsOf = (file: CredentialFileWire): CredentialFileContents => ({
  credentials: file.credentials,
  providerKeys: file.version === 1 ? [] : file.providerKeys,
  connectionCredentials: file.version === 3 ? file.connectionCredentials : [],
});

export interface CredentialIdentity {
  readonly organization: string;
  readonly actorUserId: string;
}

export type CredentialSource = "env" | "stored-key" | "stored-oauth" | "client-credentials" | "github-cli";

export interface Credential {
  readonly source: CredentialSource;
  readonly token: Redacted.Redacted<string>;
  readonly identity: CredentialIdentity | null;
}

export interface StoredCredentials {
  readonly load: Effect.Effect<ReadonlyArray<StoredCredential>>;
  readonly save: (credential: StoredCredential) => Effect.Effect<void, CredentialError>;
  readonly loadProviderKeys?: Effect.Effect<ReadonlyArray<StoredProviderKey>>;
  readonly saveProviderKey?: (key: StoredProviderKey) => Effect.Effect<void, CredentialError>;
  readonly loadConnectionCredentials?: Effect.Effect<ReadonlyArray<StoredConnectionCredential>>;
  readonly saveConnectionCredential?: (
    credential: StoredConnectionCredential,
  ) => Effect.Effect<void, CredentialError>;
  readonly removeConnectionCredential?: (connectionId: ConnectionId) => Effect.Effect<void, CredentialError>;
  readonly removeCredential?: (
    issueTracker: string,
    organization: string,
  ) => Effect.Effect<void, CredentialError>;
}

export interface ProviderAccount {
  readonly provider: string;
  readonly envVars: ReadonlyArray<string>;
}

export type ProviderKeySource = "stored-key" | "env";

export interface ProviderCredential {
  readonly source: ProviderKeySource;
  readonly key: Redacted.Redacted<string>;
}

export interface TokenRefreshRequest {
  readonly account: string;
  readonly clientId: string;
  readonly refreshToken: Redacted.Redacted<string>;
}

export type TokenRefresh = (request: TokenRefreshRequest) => Effect.Effect<StoredToken, CredentialError>;

const refreshUnavailable: TokenRefresh = (request) =>
  Effect.fail(
    new CredentialError({
      account: request.account,
      message: `cannot refresh the stored token for ${request.account}: this credential store has no token refresh wired`,
    }),
  );

// `token` answers `null` for an account that never asked for client credentials, never an error.
export interface ClientCredentialsGrant {
  readonly token: (
    account: CredentialAccount,
  ) => Effect.Effect<Redacted.Redacted<string> | null, CredentialError>;
  readonly forget: (account: CredentialAccount) => Effect.Effect<void>;
}

export interface CredentialSources {
  readonly stored: StoredCredentials;
  readonly clientCredentials?: ClientCredentialsGrant;
  readonly githubCli?: {
    readonly discover: Effect.Effect<Redacted.Redacted<string>, CredentialError>;
    readonly acquire: (account: string) => Effect.Effect<Redacted.Redacted<string>, CredentialError>;
  };
  readonly refresh?: TokenRefresh;
}

export interface CredentialStoreService {
  readonly bearerToken: (account: CredentialAccount) => Effect.Effect<Credential, CredentialError>;
  // Resolves a source that has not been persisted yet, so a proposed credential can be checked
  // before it replaces the one already on disk.
  readonly resolveSource: (
    account: CredentialAccount,
    source: ConnectionSource,
  ) => Effect.Effect<Credential, CredentialError>;
  readonly persist: (credential: StoredCredential) => Effect.Effect<void, CredentialError>;
  readonly invalidate: (account: CredentialAccount) => Effect.Effect<void>;
  readonly providerKey: (account: ProviderAccount) => Effect.Effect<ProviderCredential, CredentialError>;
  readonly persistProviderKey: (key: StoredProviderKey) => Effect.Effect<void, CredentialError>;
  readonly configureConnection: (
    connectionId: ConnectionId,
    source: ConnectionSource,
  ) => Effect.Effect<void, CredentialError>;
  readonly removeConnection: (connectionId: ConnectionId) => Effect.Effect<void, CredentialError>;
}

export class CredentialStore extends Context.Service<CredentialStore, CredentialStoreService>()(
  "@cogwork/engine/credential-store/CredentialStore",
) {}

export const accountOf = (credential: StoredCredential) =>
  `${credential.issueTracker}/${credential.organization}`;

const redactedEnv = (name: string) =>
  Config.redacted(name).pipe(Effect.orElseSucceed(() => Redacted.make("")));

const envCredential = Effect.fn("CredentialStore.env")(function* (account: CredentialAccount) {
  const configured = yield* redactedEnv(account.tokenEnv);
  const token = Redacted.value(configured).trim();
  if (token === "") {
    return yield* new CredentialError({
      account: account.key,
      message: `no credential for ${account.key}: ${account.tokenEnv} is unset or empty`,
    });
  }
  return { source: "env", token: Redacted.make(token), identity: null } satisfies Credential;
});

const matching = (account: CredentialAccount) => (credential: StoredCredential) =>
  credential.issueTracker === account.issueTracker &&
  (account.organization === null || credential.organization === account.organization);

export const expiryMargin = Duration.minutes(1);

interface StoredMatch {
  readonly credential: StoredCredential;
  readonly live: boolean;
}

const matchStored = Effect.fn("CredentialStore.matchStored")(function* (
  stored: StoredCredentials,
  account: CredentialAccount,
) {
  const candidates = (yield* stored.load).filter(matching(account));
  if (candidates.length > 1) {
    yield* Effect.logWarning("multiple stored credentials match; set issueTracker.organization", {
      account: account.key,
      matches: candidates.length,
    });
    return null;
  }
  const credential = candidates[0];
  if (!credential) return null;
  const now = yield* Clock.currentTimeMillis;
  const live = credential.token.expiresAtMillis > now + Duration.toMillis(expiryMargin);
  return { credential, live } satisfies StoredMatch;
});

const storedCredential = (credential: StoredCredential) =>
  ({
    source: "stored-oauth",
    token: credential.token.accessToken,
    identity: { organization: credential.organization, actorUserId: credential.actorUserId },
  }) satisfies Credential;

const missingProviderKeyMessage = (account: ProviderAccount) =>
  account.envVars.length > 0
    ? `no api key for ${account.provider}: log in or set ${account.envVars.join(" or ")}`
    : `no api key for ${account.provider}: log in to store one`;

export const make = (sources: CredentialSources): CredentialStoreService => {
  const refresh = sources.refresh ?? refreshUnavailable;
  const gates = new Map<string, Semaphore.Semaphore>();
  const gateFor = (key: string) => {
    const existing = gates.get(key);
    if (existing) return existing;
    const gate = Semaphore.makeUnsafe(1);
    gates.set(key, gate);
    return gate;
  };

  const rotate = Effect.fn("CredentialStore.rotate")(function* (
    account: CredentialAccount,
    stale: StoredCredential,
    clientId: string,
    fallbackRefreshToken: Redacted.Redacted<string>,
  ) {
    // Not a redundant load: whoever held the gate first rewrote the file, and reading it again is
    // what stops the fibers queued behind them spending the same refresh token over again.
    const match = yield* matchStored(sources.stored, account);
    if (match?.live) return match.credential;
    const credential = match?.credential ?? stale;
    const presented = credential.token.refreshToken ?? fallbackRefreshToken;
    const token = yield* refresh({ account: account.key, clientId, refreshToken: presented });
    // Linear leaves refresh_token out of a response when it does not rotate one, so the presented
    // token has to carry forward or the next refresh has nothing to present.
    const rotated = {
      ...credential,
      token: { ...token, refreshToken: token.refreshToken ?? presented },
    } satisfies StoredCredential;
    yield* sources.stored.save(rotated);
    yield* Effect.logInfo("refreshed the stored credential", {
      account: account.key,
      organization: rotated.organization,
    });
    return rotated;
  });

  const resolveStored = Effect.fn("CredentialStore.resolveStored")(function* (account: CredentialAccount) {
    const match = yield* matchStored(sources.stored, account);
    if (!match) return null;
    if (match.live) return match.credential;
    const clientId = account.oauthClientId ?? match.credential.oauthClientId;
    const refreshToken = match.credential.token.refreshToken;
    if (!clientId || !refreshToken) {
      yield* Effect.logInfo("stored credential expired and cannot be refreshed; falling through", {
        account: account.key,
        organization: match.credential.organization,
      });
      return null;
    }
    return yield* gateFor(accountOf(match.credential)).withPermit(
      rotate(account, match.credential, clientId, refreshToken),
    );
  });

  const grantedCredential = Effect.fn("CredentialStore.clientCredentials")(function* (
    grant: ClientCredentialsGrant | undefined,
    account: CredentialAccount,
  ) {
    const token = grant ? yield* grant.token(account) : null;
    if (!token) return null;
    return { source: "client-credentials", token, identity: null } satisfies Credential;
  });

  const resolveStoredGrant = Effect.fn("CredentialStore.resolveStoredGrant")(function* (
    account: CredentialAccount,
  ) {
    const candidate = yield* resolveStored(account);
    if (candidate) return storedCredential(candidate);
    return yield* new CredentialError({
      account: account.key,
      message: `no saved browser login for ${account.key}`,
    });
  });

  const resolveGitHubCli = Effect.fn("CredentialStore.resolveGitHubCli")(function* (
    account: CredentialAccount,
  ) {
    if (account.issueTracker !== "github") {
      return yield* new CredentialError({
        account: account.key,
        message: "GitHub CLI credentials are available only for GitHub Connections",
      });
    }
    const source = sources.githubCli;
    if (!source) {
      return yield* new CredentialError({
        account: account.key,
        message: "GitHub CLI (`gh`) not found",
      });
    }
    const token = account.organization ? yield* source.acquire(account.organization) : yield* source.discover;
    return { source: "github-cli", token, identity: null } satisfies Credential;
  });

  const resolveSource = (
    account: CredentialAccount,
    source: ConnectionSource,
  ): Effect.Effect<Credential, CredentialError> =>
    ConnectionSource.match(source, {
      ApiKey: ({ key }): Effect.Effect<Credential, CredentialError> =>
        Effect.succeed({ source: "stored-key", token: key, identity: null }),
      Env: ({ name }): Effect.Effect<Credential, CredentialError> =>
        envCredential({ ...account, tokenEnv: name }),
      GitHubCli: (): Effect.Effect<Credential, CredentialError> => resolveGitHubCli(account),
      Stored: (): Effect.Effect<Credential, CredentialError> => resolveStoredGrant(account),
    });

  const resolve = Effect.fn("CredentialStore.resolve")(function* (account: CredentialAccount) {
    const connectionCredentials = yield* sources.stored.loadConnectionCredentials ?? Effect.succeed([]);
    const configured = connectionCredentials.find((entry) => entry.connectionId === account.connectionId);
    if (configured) return yield* resolveSource(account, configured);
    const candidate = yield* resolveStored(account);
    if (candidate) return storedCredential(candidate);
    const granted = yield* grantedCredential(sources.clientCredentials, account);
    return granted ?? (yield* envCredential(account));
  });

  const validateStoredConnection = Effect.fn("CredentialStore.validateStoredConnection")(function* (
    connectionId: ConnectionId,
  ) {
    const system = connectionSystemOf(connectionId);
    if (!system) {
      return yield* new CredentialError({
        account: connectionId,
        message: `invalid Connection id: ${connectionId}`,
      });
    }
    const account = connectionAccountOf(connectionId);
    const credential = yield* resolveStored({
      connectionId,
      key: connectionId,
      issueTracker: system,
      organization: account === "default" ? null : account,
      tokenEnv: system === "github" ? "GITHUB_TOKEN" : "LINEAR_API_KEY",
      clientCredentials: null,
      oauthClientId: null,
    });
    if (credential) return;
    return yield* new CredentialError({
      account: connectionId,
      message: `no saved browser login for ${connectionId}`,
    });
  });

  const loadProviderKeys = sources.stored.loadProviderKeys ?? Effect.succeed([]);

  const configureConnection = Effect.fn("CredentialStore.configureConnection")(function* (
    connectionId: ConnectionId,
    source: ConnectionSource,
  ) {
    if (source._tag === "Env") {
      const configured = yield* redactedEnv(source.name);
      if (Redacted.value(configured).trim() === "") {
        return yield* new CredentialError({
          account: connectionId,
          message: `${source.name} is unset or empty`,
        });
      }
    }
    if (source._tag === "Stored") yield* validateStoredConnection(connectionId);
    const save = sources.stored.saveConnectionCredential;
    if (!save) {
      return yield* new CredentialError({
        account: connectionId,
        message: "this credential store cannot persist Connection credentials",
      });
    }
    yield* save({ ...source, connectionId });
  });

  const firstEnvKey = (envVars: ReadonlyArray<string>) =>
    Effect.reduce(
      envVars,
      () => "",
      (found, name) =>
        found !== ""
          ? Effect.succeed(found)
          : Effect.map(redactedEnv(name), (value) => Redacted.value(value).trim()),
    );

  const providerKey = Effect.fn("CredentialStore.providerKey")(function* (account: ProviderAccount) {
    const stored = (yield* loadProviderKeys).find((entry) => entry.provider === account.provider);
    if (stored) {
      yield* Effect.logDebug("provider key resolved", { provider: account.provider, source: "stored-key" });
      return { source: "stored-key", key: stored.key } satisfies ProviderCredential;
    }
    const fromEnv = yield* firstEnvKey(account.envVars);
    if (fromEnv !== "") {
      yield* Effect.logDebug("provider key resolved", { provider: account.provider, source: "env" });
      return { source: "env", key: Redacted.make(fromEnv) } satisfies ProviderCredential;
    }
    return yield* new CredentialError({
      account: account.provider,
      message: missingProviderKeyMessage(account),
    });
  });

  return {
    bearerToken: Effect.fn("CredentialStore.bearerToken")(function* (account: CredentialAccount) {
      const credential = yield* resolve(account);
      yield* Effect.logDebug("credential resolved", {
        account: account.key,
        source: credential.source,
      });
      return credential;
    }),
    resolveSource,
    persist: sources.stored.save,
    invalidate: (account) => sources.clientCredentials?.forget(account) ?? Effect.void,
    providerKey,
    persistProviderKey: (key) =>
      sources.stored.saveProviderKey?.(key) ??
      Effect.fail(
        new CredentialError({
          account: key.provider,
          message: "this credential store cannot persist provider keys",
        }),
      ),
    configureConnection,
    removeConnection: (connectionId) => {
      const system = connectionSystemOf(connectionId);
      const account = connectionAccountOf(connectionId);
      const removeConnectionCredential =
        sources.stored.removeConnectionCredential?.(connectionId) ?? Effect.void;
      const removeCredential =
        system === null ? Effect.void : (sources.stored.removeCredential?.(system, account) ?? Effect.void);
      return Effect.all([removeConnectionCredential, removeCredential], { discard: true });
    },
  };
};

export const envOnly: StoredCredentials = {
  load: Effect.succeed([]),
  save: (credential) =>
    Effect.fail(
      new CredentialError({
        account: accountOf(credential),
        message: "the environment credential store cannot persist tokens",
      }),
    ),
};

export const layerEnv = Layer.succeed(CredentialStore, make({ stored: envOnly }));
