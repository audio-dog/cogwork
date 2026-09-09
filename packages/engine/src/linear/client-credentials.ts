import * as Cache from "effect/Cache";
import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import {
  type ClientCredentialsGrant,
  type ClientCredentialsRef,
  type CredentialAccount,
  CredentialError,
  expiryMargin,
} from "../credential-store";
import {
  clientCredentialsRequest,
  decodeTokenResponse,
  tokenEndpointDeadline,
  withTokenEndpointDeadline,
} from "./oauth";

class GrantKey extends Data.Class<{
  readonly account: string;
  readonly clientId: string;
  readonly secretEnv: string;
}> {}

interface MintedToken {
  readonly accessToken: Redacted.Redacted<string>;
  readonly lifetimeMillis: number;
}

const capacity = 32;

const keyOf = (account: CredentialAccount, ref: ClientCredentialsRef) =>
  new GrantKey({ account: account.key, clientId: ref.clientId, secretEnv: ref.secretEnv });

const failure = (key: GrantKey, message: string) =>
  new CredentialError({ account: key.account, message, retryable: false });

const secretOf = Effect.fn("linear.clientCredentials.secret")(function* (key: GrantKey) {
  const configured = yield* Effect.orElseSucceed(Config.redacted(key.secretEnv), () => Redacted.make(""));
  const secret = Redacted.value(configured).trim();
  if (secret === "") {
    return yield* failure(
      key,
      `client credentials for ${key.account} need ${key.secretEnv}, which is unset or empty`,
    );
  }
  return Redacted.make(secret);
});

// Nothing here may put a cause or a response body into an error: the request carries the client
// secret, and Linear echoes request parameters back in some of its token-endpoint failures.
const mint = (http: HttpClient.HttpClient) =>
  Effect.fn("linear.clientCredentials.mint")(function* (key: GrantKey) {
    const clientSecret = yield* secretOf(key);
    const form = clientCredentialsRequest({ clientId: key.clientId, clientSecret });
    return yield* withTokenEndpointDeadline(
      Effect.gen(function* () {
        const response = yield* Effect.mapError(
          http.execute(
            HttpClientRequest.post(form.url).pipe(
              HttpClientRequest.setHeaders(form.headers),
              HttpClientRequest.bodyText(form.body, form.headers["content-type"]),
            ),
          ),
          () => failure(key, `could not reach Linear's token endpoint for ${key.account}`),
        );
        if (response.status !== 200) {
          return yield* failure(
            key,
            `Linear rejected the client credentials for ${key.account} (HTTP ${response.status})`,
          );
        }
        const decoded = yield* Effect.mapError(Effect.flatMap(response.json, decodeTokenResponse), () =>
          failure(key, `Linear returned an unreadable token response for ${key.account}`),
        );
        yield* Effect.logInfo("minted a Linear client-credentials token", {
          account: key.account,
          expiresInSeconds: decoded.expires_in,
        });
        return {
          accessToken: Redacted.make(decoded.access_token),
          lifetimeMillis: decoded.expires_in * 1000,
        } satisfies MintedToken;
      }),
      () =>
        failure(key, `Linear's token endpoint timed out after ${tokenEndpointDeadline} for ${key.account}`),
    );
  });

const timeToLive = (exit: Exit.Exit<MintedToken, CredentialError>) =>
  Exit.isSuccess(exit)
    ? Duration.max(Duration.zero, Duration.subtract(Duration.millis(exit.value.lifetimeMillis), expiryMargin))
    : Duration.zero;

export const make = Effect.fn("linear.clientCredentials")(function* () {
  const http = yield* HttpClient.HttpClient;
  const cache = yield* Cache.makeWith(mint(http), { capacity, timeToLive });
  return {
    token: (account) => {
      const ref = account.clientCredentials;
      if (!ref) return Effect.succeed(null);
      return Effect.map(Cache.get(cache, keyOf(account, ref)), (minted) => minted.accessToken);
    },
    forget: (account) => {
      const ref = account.clientCredentials;
      return ref ? Cache.invalidate(cache, keyOf(account, ref)) : Effect.void;
    },
  } satisfies ClientCredentialsGrant;
});
