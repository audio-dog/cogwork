import { TrimmedNonEmptyString } from "@clanker-forge/contracts";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

// Naming the secret's env var is how an operator asks for the client-credentials source at all: an
// OAuth app configured for browser login alone leaves it unset and keeps the legacy env-key floor.
export interface ClientCredentialsRef {
  readonly clientId: string;
  readonly secretEnv: string;
}

export interface CredentialAccount {
  readonly key: string;
  readonly workSource: string;
  readonly organization: string | null;
  readonly tokenEnv: string;
  readonly clientCredentials: ClientCredentialsRef | null;
}

export class CredentialError extends Schema.TaggedErrorClass<CredentialError>()("CredentialError", {
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
  workSource: TrimmedNonEmptyString,
  organization: TrimmedNonEmptyString,
  botUserId: TrimmedNonEmptyString,
  token: StoredToken,
});
export type StoredCredential = typeof StoredCredential.Type;

export const CredentialFile = Schema.Struct({
  version: Schema.Literal(1),
  credentials: Schema.Array(StoredCredential),
});
export type CredentialFile = typeof CredentialFile.Type;

export interface CredentialIdentity {
  readonly organization: string;
  readonly botUserId: string;
}

export type CredentialSource = "env" | "stored-oauth" | "client-credentials";

export interface Credential {
  readonly source: CredentialSource;
  readonly token: Redacted.Redacted<string>;
  readonly identity: CredentialIdentity | null;
}

export interface StoredCredentials {
  readonly load: Effect.Effect<ReadonlyArray<StoredCredential>>;
  readonly save: (credential: StoredCredential) => Effect.Effect<void, CredentialError>;
}

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
}

export interface CredentialStoreService {
  readonly bearerToken: (account: CredentialAccount) => Effect.Effect<Credential, CredentialError>;
  readonly persist: (credential: StoredCredential) => Effect.Effect<void, CredentialError>;
  readonly invalidate: (account: CredentialAccount) => Effect.Effect<void>;
}

export class CredentialStore extends Context.Service<CredentialStore, CredentialStoreService>()(
  "@clanker-forge/engine/CredentialStore",
) {}

export const accountOf = (credential: StoredCredential) =>
  `${credential.workSource}/${credential.organization}`;

const envToken = (account: CredentialAccount) =>
  Config.redacted(account.tokenEnv).pipe(Effect.orElseSucceed(() => Redacted.make("")));

const envCredential = Effect.fn("CredentialStore.env")(function* (account: CredentialAccount) {
  const configured = yield* envToken(account);
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
  credential.workSource === account.workSource &&
  (account.organization === null || credential.organization === account.organization);

// Nothing refreshes a stored token yet, so one that lapses mid-request comes back as an opaque 401
// instead of falling back; the margin keeps a request from starting on a token that close to expiry.
export const expiryMarginMillis = 60_000;

const selectStored = Effect.fn("CredentialStore.selectStored")(function* (
  stored: StoredCredentials,
  account: CredentialAccount,
) {
  const candidates = (yield* stored.load).filter(matching(account));
  if (candidates.length > 1) {
    yield* Effect.logWarning("multiple stored credentials match; set workSource.organization", {
      account: account.key,
      matches: candidates.length,
    });
    return null;
  }
  const candidate = candidates[0];
  if (!candidate) return null;
  const now = yield* Clock.currentTimeMillis;
  if (candidate.token.expiresAtMillis > now + expiryMarginMillis) return candidate;
  yield* Effect.logInfo("stored credential expired; falling back to the environment", {
    account: account.key,
    organization: candidate.organization,
  });
  return null;
});

const storedCredential = (credential: StoredCredential) =>
  ({
    source: "stored-oauth",
    token: credential.token.accessToken,
    identity: { organization: credential.organization, botUserId: credential.botUserId },
  }) satisfies Credential;

const grantedCredential = Effect.fn("CredentialStore.clientCredentials")(function* (
  grant: ClientCredentialsGrant | undefined,
  account: CredentialAccount,
) {
  const token = grant ? yield* grant.token(account) : null;
  if (!token) return null;
  return { source: "client-credentials", token, identity: null } satisfies Credential;
});

const resolve = Effect.fn("CredentialStore.resolve")(function* (
  sources: CredentialSources,
  account: CredentialAccount,
) {
  const candidate = yield* selectStored(sources.stored, account);
  if (candidate) return storedCredential(candidate);
  const granted = yield* grantedCredential(sources.clientCredentials, account);
  return granted ?? (yield* envCredential(account));
});

export const make = (sources: CredentialSources): CredentialStoreService => ({
  bearerToken: Effect.fn("CredentialStore.bearerToken")(function* (account: CredentialAccount) {
    const credential = yield* resolve(sources, account);
    yield* Effect.logDebug("credential resolved", {
      account: account.key,
      source: credential.source,
    });
    return credential;
  }),
  persist: sources.stored.save,
  invalidate: (account) => sources.clientCredentials?.forget(account) ?? Effect.void,
});

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
