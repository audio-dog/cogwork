import { TrimmedNonEmptyString } from "@clanker-forge/contracts";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export interface CredentialAccount {
  readonly key: string;
  readonly workSource: string;
  readonly organization: string | null;
  readonly tokenEnv: string;
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

export type CredentialSource = "env" | "stored-oauth";

export interface Credential {
  readonly source: CredentialSource;
  readonly token: Redacted.Redacted<string>;
  readonly identity: CredentialIdentity | null;
}

export interface StoredCredentials {
  readonly load: Effect.Effect<ReadonlyArray<StoredCredential>>;
  readonly save: (credential: StoredCredential) => Effect.Effect<void, CredentialError>;
}

export interface CredentialStoreService {
  readonly bearerToken: (account: CredentialAccount) => Effect.Effect<Credential, CredentialError>;
  readonly persist: (credential: StoredCredential) => Effect.Effect<void, CredentialError>;
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
const expiryMarginMillis = 60_000;

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

export const make = (stored: StoredCredentials): CredentialStoreService => ({
  bearerToken: Effect.fn("CredentialStore.bearerToken")(function* (account: CredentialAccount) {
    const candidate = yield* selectStored(stored, account);
    const credential = candidate ? storedCredential(candidate) : yield* envCredential(account);
    yield* Effect.logDebug("credential resolved", {
      account: account.key,
      source: credential.source,
    });
    return credential;
  }),
  persist: stored.save,
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

export const layerEnv = Layer.succeed(CredentialStore, make(envOnly));
