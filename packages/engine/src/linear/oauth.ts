import type { OAuthAppConfig } from "@cogwork/contracts";
import { LinearClient as LinearSdk } from "@linear/sdk";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import {
  CredentialError,
  type StoredToken,
  type TokenRefresh,
  type TokenRefreshRequest,
} from "../credential-store";

// The GraphQL API only covers requests made with a token already in hand; getting that token is a
// two-legged redirect + POST flow the SDK does not wrap, so these two endpoints stay hand-built.
export const authorizeEndpoint = "https://linear.app/oauth/authorize";
export const tokenEndpoint = "https://api.linear.app/oauth/token";
export const tokenEndpointDeadline = "30 seconds";
const identityRequestDeadline = "30 seconds";

export const withTokenEndpointDeadline = <A, E, R>(operation: Effect.Effect<A, E, R>, onTimeout: () => E) =>
  operation.pipe(
    Effect.timeout(tokenEndpointDeadline),
    Effect.catchTag("TimeoutError", () => Effect.fail(onTimeout())),
  );

export const defaultRedirectPort = 39_517;
export const defaultScopes = ["read", "write", "app:assignable", "app:mentionable"] as const;

// Linear only accepts redirect URLs pre-registered on the OAuth app, so the configurable port has to
// match one the app was registered with rather than being a free choice.
export const redirectUri = (port: number) => `http://localhost:${port}/oauth/callback`;

export const redirectUriFor = (oauth: OAuthAppConfig) =>
  redirectUri(oauth.redirectPort ?? defaultRedirectPort);

const utf8 = new TextEncoder();

export const codeChallenge = Effect.fn("linear.oauth.codeChallenge")(function* (verifier: string) {
  const crypto = yield* Crypto.Crypto;
  const digest = yield* crypto.digest("SHA-256", utf8.encode(verifier));
  return Encoding.encodeBase64Url(digest);
});

export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
}

export const makePkce = Effect.fn("linear.oauth.pkce")(function* () {
  const crypto = yield* Crypto.Crypto;
  const verifier = Encoding.encodeBase64Url(yield* crypto.randomBytes(32));
  return { verifier, challenge: yield* codeChallenge(verifier) } satisfies PkcePair;
});

export const makeState = Effect.fn("linear.oauth.state")(function* () {
  const crypto = yield* Crypto.Crypto;
  return Encoding.encodeBase64Url(yield* crypto.randomBytes(16));
});

export interface AuthorizeParams {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly challenge: string;
  readonly scopes?: ReadonlyArray<string>;
}

export const authorizeUrl = (params: AuthorizeParams) => {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    scope: (params.scopes ?? defaultScopes).join(","),
    state: params.state,
    code_challenge: params.challenge,
    code_challenge_method: "S256",
    actor: "app",
    prompt: "consent",
  });
  return `${authorizeEndpoint}?${query.toString()}`;
};

export interface TokenExchangeParams {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly code: string;
  readonly verifier: string;
}

export interface FormRequest {
  readonly url: string;
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export const tokenExchangeRequest = (params: TokenExchangeParams) =>
  ({
    url: tokenEndpoint,
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: params.clientId,
      redirect_uri: params.redirectUri,
      code: params.code,
      code_verifier: params.verifier,
    }).toString(),
  }) satisfies FormRequest;

export interface ClientCredentialsParams {
  readonly clientId: string;
  readonly clientSecret: Redacted.Redacted<string>;
  readonly scopes?: ReadonlyArray<string>;
}

// The grant mints an `app`-actor token on its own, so unlike the authorize URL it takes no `actor`
// parameter; Linear rejects the request outright unless the app has client-credentials enabled.
export const clientCredentialsRequest = (params: ClientCredentialsParams) =>
  ({
    url: tokenEndpoint,
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: params.clientId,
      client_secret: Redacted.value(params.clientSecret),
      scope: (params.scopes ?? defaultScopes).join(","),
    }).toString(),
  }) satisfies FormRequest;

const Scopes = Schema.Union([Schema.String, Schema.Array(Schema.String)]);

export const TokenResponse = Schema.Struct({
  access_token: Schema.String.check(Schema.isNonEmpty()),
  token_type: Schema.String,
  expires_in: Schema.Finite,
  scope: Scopes,
  refresh_token: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
});
export type TokenResponse = typeof TokenResponse.Type;

export const decodeTokenResponse = Schema.decodeUnknownEffect(TokenResponse);

export const exchangeToken = Effect.fn("linear.oauth.exchangeToken")(function* (params: TokenExchangeParams) {
  const client = yield* HttpClient.HttpClient;
  const request = tokenExchangeRequest(params);
  return yield* withTokenEndpointDeadline(
    Effect.gen(function* () {
      const response = yield* client
        .execute(
          HttpClientRequest.post(request.url).pipe(
            HttpClientRequest.setHeaders(request.headers),
            HttpClientRequest.bodyText(request.body, request.headers["content-type"]),
          ),
        )
        .pipe(
          Effect.catchTag("HttpClientError", (error) =>
            Effect.fail(
              new LinearOAuthError({
                message: `Linear token exchange could not reach Linear: ${error.message}`,
              }),
            ),
          ),
        );
      if (response.status >= 400) {
        return yield* new LinearOAuthError({
          message: `Linear rejected the token exchange (HTTP ${response.status})`,
        });
      }
      const body = yield* response.json.pipe(
        Effect.catchTag("HttpClientError", () =>
          Effect.fail(new LinearOAuthError({ message: "Linear token exchange returned an unreadable body" })),
        ),
      );
      return yield* decodeTokenResponse(body).pipe(
        Effect.mapError(
          () => new LinearOAuthError({ message: "Linear token exchange returned an unexpected shape" }),
        ),
      );
    }),
    () => new LinearOAuthError({ message: `Linear token exchange timed out after ${tokenEndpointDeadline}` }),
  );
});

const scopesOf = (scope: TokenResponse["scope"]) =>
  typeof scope === "string" ? scope.split(/[\s,]+/).filter((entry) => entry.length > 0) : scope;

export const storedTokenFrom = (response: TokenResponse, nowMillis: number) =>
  ({
    accessToken: Redacted.make(response.access_token),
    refreshToken: response.refresh_token ? Redacted.make(response.refresh_token) : null,
    expiresAtMillis: nowMillis + response.expires_in * 1000,
    scopes: scopesOf(response.scope),
  }) satisfies StoredToken;

// A PKCE app has no client secret, so the refresh grant carries only the client id alongside the
// refresh token.
const refreshRequest = (request: TokenRefreshRequest) =>
  HttpClientRequest.post(tokenEndpoint).pipe(
    HttpClientRequest.setHeader("accept", "application/json"),
    HttpClientRequest.bodyUrlParams({
      grant_type: "refresh_token",
      client_id: request.clientId,
      refresh_token: Redacted.value(request.refreshToken),
    }),
  );

// Transport errors and schema issues both quote the payload that failed, and here that payload is
// the token pair itself, so no cause may reach the reported message.
const refreshFailed = (account: string, detail: string) =>
  new CredentialError({ account, message: `Linear token refresh failed: ${detail}`, retryable: false });

export const makeTokenRefresh = (client: HttpClient.HttpClient): TokenRefresh =>
  Effect.fn("linear.oauth.tokenRefresh")(function* (request: TokenRefreshRequest) {
    return yield* withTokenEndpointDeadline(
      Effect.gen(function* () {
        const response = yield* Effect.mapError(client.execute(refreshRequest(request)), () =>
          refreshFailed(request.account, "the token endpoint could not be reached"),
        );
        if (response.status !== 200) {
          return yield* refreshFailed(request.account, `the token endpoint returned ${response.status}`);
        }
        const body = yield* Effect.mapError(response.json, () =>
          refreshFailed(request.account, "the token endpoint returned an unreadable body"),
        );
        const decoded = yield* Effect.mapError(decodeTokenResponse(body), () =>
          refreshFailed(request.account, "the token endpoint returned an unexpected payload"),
        );
        const now = yield* Clock.currentTimeMillis;
        return storedTokenFrom(decoded, now);
      }),
      () => refreshFailed(request.account, `the token endpoint timed out after ${tokenEndpointDeadline}`),
    );
  });

export class LinearOAuthError extends Schema.TaggedError<LinearOAuthError>()("LinearOAuthError", {
  message: Schema.String,
}) {}

export interface DiscoveredIdentity {
  readonly organization: string;
  readonly actorUserId: string;
}

// The org's urlKey is what `issueTracker.organization` config and `StoredCredential.organization`
// carry — it's the slug operators already see in Linear's URLs, unlike the opaque org id.
export const discoverIdentity = Effect.fn("linear.oauth.discoverIdentity")(function* (accessToken: string) {
  const [viewer, organization] = yield* Effect.tryPromise({
    try: (signal) => {
      const sdk = new LinearSdk({ accessToken, signal });
      return Promise.all([sdk.viewer, sdk.organization]);
    },
    catch: (cause) =>
      new LinearOAuthError({
        message: `Linear identity discovery failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  }).pipe(
    Effect.timeout(identityRequestDeadline),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(
        new LinearOAuthError({
          message: `Linear identity discovery timed out after ${identityRequestDeadline}`,
        }),
      ),
    ),
  );
  return { organization: organization.urlKey, actorUserId: viewer.id } satisfies DiscoveredIdentity;
});
