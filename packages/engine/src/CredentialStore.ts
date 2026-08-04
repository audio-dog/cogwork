import { TrimmedNonEmptyString } from "@clanker-forge/contracts";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

export interface CredentialAccount {
  readonly key: string;
  readonly workSource: string;
  readonly organization: string | null;
  readonly tokenEnv: string;
  readonly clientId: string | null;
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

const expiryMarginMillis = 60_000;

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
    yield* Effect.logWarning("multiple stored credentials match; set workSource.organization", {
      account: account.key,
      matches: candidates.length,
    });
    return null;
  }
  const credential = candidates[0];
  if (!credential) return null;
  const now = yield* Clock.currentTimeMillis;
  const live = credential.token.expiresAtMillis > now + expiryMarginMillis;
  return { credential, live } satisfies StoredMatch;
});

const storedCredential = (credential: StoredCredential) =>
  ({
    source: "stored-oauth",
    token: credential.token.accessToken,
    identity: { organization: credential.organization, botUserId: credential.botUserId },
  }) satisfies Credential;

export const make = (
  stored: StoredCredentials,
  refresh: TokenRefresh = refreshUnavailable,
): CredentialStoreService => {
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
    const match = yield* matchStored(stored, account);
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
    yield* stored.save(rotated);
    yield* Effect.logInfo("refreshed the stored credential", {
      account: account.key,
      organization: rotated.organization,
    });
    return rotated;
  });

  const resolveStored = Effect.fn("CredentialStore.resolveStored")(function* (account: CredentialAccount) {
    const match = yield* matchStored(stored, account);
    if (!match) return null;
    if (match.live) return match.credential;
    const { clientId } = account;
    const refreshToken = match.credential.token.refreshToken;
    if (!clientId || !refreshToken) {
      yield* Effect.logInfo("stored credential expired and cannot be refreshed; using the environment", {
        account: account.key,
        organization: match.credential.organization,
      });
      return null;
    }
    return yield* gateFor(accountOf(match.credential)).withPermit(
      rotate(account, match.credential, clientId, refreshToken),
    );
  });

  return {
    bearerToken: Effect.fn("CredentialStore.bearerToken")(function* (account: CredentialAccount) {
      const candidate = yield* resolveStored(account);
      const credential = candidate ? storedCredential(candidate) : yield* envCredential(account);
      yield* Effect.logDebug("credential resolved", {
        account: account.key,
        source: credential.source,
      });
      return credential;
    }),
    persist: stored.save,
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

export const layerEnv = Layer.succeed(CredentialStore, make(envOnly));
