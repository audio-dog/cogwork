// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as Http from "node:http";
import { ConnectionFailure } from "@cogwork/contracts";
import { CredentialStore, Linear, Slack } from "@cogwork/engine";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { awaitLoopbackAuthorization, BrowserOpener, browserOpenerLayer } from "./login";

export const slackClientId = "663911259169.12446984597813";
export const slackAppId = "A0CD4UYHKPX";
export const slackRedirectUri = "http://localhost:39517/oauth/callback";
export const slackScopes = [
  "channels:history",
  "groups:history",
  "im:history",
  "mpim:history",
  "channels:read",
  "groups:read",
  "im:read",
  "mpim:read",
  "users:read",
  "chat:write",
  "reactions:read",
  "reactions:write",
  "emoji:read",
  "search:read",
  "search:read.public",
  "search:read.private",
  "search:read.im",
  "search:read.mpim",
  "search:read.users",
] as const;

export interface SlackLoginConfig {
  readonly appId: string;
  readonly clientId: string;
  readonly authorizeEndpoint: string;
  readonly tokenEndpoint: string;
  readonly redirectUri: string;
}

const defaultConfig: SlackLoginConfig = {
  appId: slackAppId,
  clientId: slackClientId,
  authorizeEndpoint: "https://slack.com/oauth/v2_user/authorize",
  tokenEndpoint: "https://slack.com/api/oauth.v2.user.access",
  redirectUri: slackRedirectUri,
};

const requestDeadline = "30 seconds";

const failure = (message: string) =>
  new ConnectionFailure({ operation: "login Slack", connectionId: null, message });

const TokenResponse = Schema.Struct({
  ok: Schema.Literal(true),
  access_token: Schema.NonEmptyString,
  refresh_token: Schema.NonEmptyString,
  expires_in: Schema.Finite.check(Schema.isGreaterThan(0)),
  scope: Schema.String,
  team: Schema.Struct({ id: Schema.NonEmptyString }),
  user_id: Schema.NonEmptyString,
  app_id: Schema.NonEmptyString,
});

const RefreshResponse = Schema.Struct({
  ok: Schema.Literal(true),
  access_token: Schema.NonEmptyString,
  refresh_token: Schema.NonEmptyString,
  expires_in: Schema.Finite.check(Schema.isGreaterThan(0)),
  scope: Schema.String,
});

const decodeTokenResponse = Schema.decodeUnknownEffect(TokenResponse);
const decodeRefreshResponse = Schema.decodeUnknownEffect(RefreshResponse);

const scopesOf = (scope: string) => scope.split(/[\s,]+/).filter(Boolean);

const authorizeUrl = (config: SlackLoginConfig, state: string, challenge: string) => {
  const url = new URL(config.authorizeEndpoint);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    scope: slackScopes.join(","),
    redirect_uri: config.redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return url;
};

const readBody = Effect.fn("slack.oauth.readBody")(function* (
  response: HttpClientResponse.HttpClientResponse,
  operation: string,
) {
  if (response.status !== 200) return yield* failure(`${operation} returned HTTP ${response.status}`);
  return yield* response.json.pipe(
    Effect.mapError(() => failure(`${operation} returned an unreadable body`)),
  );
});

const execute = <A, R>(effect: Effect.Effect<A, ConnectionFailure, R>, timedOut: string) =>
  effect.pipe(
    Effect.timeout(requestDeadline),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(failure(`${timedOut} timed out after ${requestDeadline}`)),
    ),
  );

const exchange = Effect.fn("slack.oauth.exchange")(function* (
  client: HttpClient.HttpClient,
  config: SlackLoginConfig,
  code: string,
  verifier: string,
) {
  const response = yield* execute(
    client
      .execute(
        HttpClientRequest.post(config.tokenEndpoint).pipe(
          HttpClientRequest.setHeader("accept", "application/json"),
          HttpClientRequest.bodyUrlParams({
            client_id: config.clientId,
            code,
            code_verifier: verifier,
            redirect_uri: config.redirectUri,
            grant_type: "authorization_code",
          }),
        ),
      )
      .pipe(Effect.mapError(() => failure("Slack token exchange could not be reached"))),
    "Slack token exchange",
  );
  const body = yield* readBody(response, "Slack token exchange");
  return yield* decodeTokenResponse(body).pipe(
    Effect.mapError(() => failure("Slack token exchange returned an unexpected payload")),
  );
});

const makeLogin = Effect.fn("slack.login")(function* (config: SlackLoginConfig) {
  const pkce = yield* Linear.OAuth.makePkce().pipe(
    Effect.mapError(() => failure("Could not create secure Slack PKCE values")),
  );
  const state = yield* Linear.OAuth.makeState().pipe(
    Effect.mapError(() => failure("Could not create a secure Slack OAuth state")),
  );
  const callback = new URL(config.redirectUri);
  const code = yield* awaitLoopbackAuthorization({
    authorizationUrl: authorizeUrl(config, state, pkce.challenge),
    expectedState: state,
    loginName: "Slack",
  }).pipe(
    Effect.mapError((error) => failure(error.message)),
    Effect.provide(
      NodeHttpServer.layer(Http.createServer, {
        host: callback.hostname,
        port: Number(callback.port),
      }),
    ),
    Effect.scoped,
    Effect.mapError((error) =>
      error._tag === "ConnectionFailure"
        ? error
        : failure(`Could not start the Slack callback server on ${callback.host}`),
    ),
  );
  const client = yield* HttpClient.HttpClient;
  const tokens = yield* exchange(client, config, code, pkce.verifier);
  if (tokens.app_id !== config.appId) return yield* failure("Slack returned a grant for another app");
  const now = yield* Clock.currentTimeMillis;
  return {
    issueTracker: "slack",
    organization: tokens.team.id,
    actorUserId: tokens.user_id,
    oauthClientId: config.clientId,
    oauthTokenEndpoint: config.tokenEndpoint,
    token: {
      accessToken: Redacted.make(tokens.access_token),
      refreshToken: Redacted.make(tokens.refresh_token),
      expiresAtMillis: now + tokens.expires_in * 1000,
      scopes: scopesOf(tokens.scope),
    },
  } satisfies CredentialStore.StoredCredential;
});

const refreshFailure = (account: string, detail: string) =>
  new CredentialStore.CredentialError({
    account,
    message: `Slack token refresh failed: ${detail}`,
    retryable: false,
  });

export const makeTokenRefresh = (client: HttpClient.HttpClient): CredentialStore.TokenRefresh =>
  Effect.fn("slack.oauth.tokenRefresh")(function* (request) {
    if (!request.tokenEndpoint) {
      return yield* refreshFailure(request.account, "the stored grant has no token endpoint");
    }
    const response = yield* client
      .execute(
        HttpClientRequest.post(request.tokenEndpoint).pipe(
          HttpClientRequest.setHeader("accept", "application/json"),
          HttpClientRequest.bodyUrlParams({
            grant_type: "refresh_token",
            refresh_token: Redacted.value(request.refreshToken),
            client_id: request.clientId,
          }),
        ),
      )
      .pipe(
        Effect.mapError(() => refreshFailure(request.account, "the token endpoint could not be reached")),
        Effect.timeout(requestDeadline),
        Effect.mapError((error) =>
          error._tag === "CredentialError"
            ? error
            : refreshFailure(request.account, `the token endpoint timed out after ${requestDeadline}`),
        ),
      );
    if (response.status !== 200) {
      return yield* refreshFailure(request.account, `the token endpoint returned ${response.status}`);
    }
    const body = yield* response.json.pipe(
      Effect.mapError(() =>
        refreshFailure(request.account, "the token endpoint returned an unreadable body"),
      ),
    );
    const tokens = yield* decodeRefreshResponse(body).pipe(
      Effect.mapError(() =>
        refreshFailure(request.account, "the token endpoint returned an unexpected payload"),
      ),
    );
    const now = yield* Clock.currentTimeMillis;
    return {
      accessToken: Redacted.make(tokens.access_token),
      refreshToken: Redacted.make(tokens.refresh_token),
      expiresAtMillis: now + tokens.expires_in * 1000,
      scopes: scopesOf(tokens.scope),
    };
  });

export const slackLoginLayer = (
  config: SlackLoginConfig = defaultConfig,
  openerLayer: Layer.Layer<BrowserOpener, never, ChildProcessSpawner> = browserOpenerLayer,
) =>
  Layer.effect(
    Slack.SlackLogin,
    Effect.gen(function* () {
      const opener = yield* BrowserOpener;
      const crypto = yield* Crypto.Crypto;
      const client = yield* HttpClient.HttpClient;
      return {
        login: makeLogin(config).pipe(
          Effect.provideService(BrowserOpener, opener),
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(HttpClient.HttpClient, client),
        ),
      };
    }),
  ).pipe(Layer.provide(openerLayer));
