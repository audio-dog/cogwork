// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as Http from "node:http";

import { ConnectionFailure } from "@cogwork/contracts";
import { CredentialStore, Granola } from "@cogwork/engine";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  auth,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import * as Clock from "effect/Clock";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { awaitLoopbackAuthorization, BrowserOpener, browserOpenerLayer } from "./login";

const oauthRequestDeadline = "30 seconds";

export interface GranolaLoginConfig {
  readonly endpoint: string;
  readonly redirectPort: number;
}

const failure = (message: string) =>
  new ConnectionFailure({ operation: "login Granola", connectionId: null, message });

const redirectUri = (port: number) => `http://127.0.0.1:${port}/oauth/callback`;

const runAuth = (
  fetchFn: typeof globalThis.fetch,
  provider: OAuthClientProvider,
  endpoint: string,
  authorizationCode?: string,
) =>
  Effect.tryPromise({
    try: (signal) =>
      auth(provider, {
        serverUrl: endpoint,
        authorizationCode,
        fetchFn: (input, init) => fetchFn(input, { ...init, signal }),
      }),
    catch: (error) => failure(error instanceof Error ? error.message : String(error)),
  }).pipe(
    Effect.timeout(oauthRequestDeadline),
    Effect.mapError((error) =>
      error._tag === "ConnectionFailure"
        ? error
        : failure(`Granola OAuth request timed out after ${oauthRequestDeadline}.`),
    ),
  );

const makeLogin = Effect.fn("granola.login")(function* (config: GranolaLoginConfig, account: string) {
  const random = yield* SecureRandom.SecureRandom;
  const fetchFn = yield* FetchHttpClient.Fetch;
  const state = Base64Url.encode(yield* random.randomBytes(16));
  const callback = redirectUri(config.redirectPort);
  const opener = yield* BrowserOpener;
  const session: {
    client?: OAuthClientInformationMixed;
    tokens?: OAuthTokens;
    verifier?: string;
    authorizationUrl?: URL;
    discovery?: OAuthDiscoveryState;
  } = {};
  const provider: OAuthClientProvider = {
    redirectUrl: callback,
    clientMetadata: {
      client_name: "Cogwork",
      redirect_uris: [callback],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    state: () => state,
    clientInformation: () => session.client,
    saveClientInformation: (client) => {
      session.client = client;
    },
    tokens: () => session.tokens,
    saveTokens: (tokens) => {
      session.tokens = tokens;
    },
    redirectToAuthorization: (url) => {
      session.authorizationUrl = url;
    },
    saveCodeVerifier: (verifier) => {
      session.verifier = verifier;
    },
    codeVerifier: () => session.verifier ?? "",
    discoveryState: () => session.discovery,
    saveDiscoveryState: (discovery) => {
      session.discovery = discovery;
    },
  };
  const first = yield* runAuth(fetchFn, provider, config.endpoint);
  if (first !== "REDIRECT" || !session.authorizationUrl) {
    return yield* failure("Granola did not start browser authorization.");
  }
  const code = yield* awaitLoopbackAuthorization({
    authorizationUrl: session.authorizationUrl,
    expectedState: state,
    loginName: "Granola",
  }).pipe(
    Effect.mapError((error) => failure(error.message)),
    Effect.provideService(BrowserOpener, opener),
    Effect.provide(NodeHttpServer.layer(Http.createServer, { host: "127.0.0.1", port: config.redirectPort })),
    Effect.scoped,
    Effect.mapError((error) =>
      error._tag === "ConnectionFailure"
        ? error
        : failure(`Could not start the Granola callback server on 127.0.0.1:${config.redirectPort}.`),
    ),
  );
  const completed = yield* runAuth(fetchFn, provider, config.endpoint, code);
  if (completed !== "AUTHORIZED" || !session.tokens || !session.client) {
    return yield* failure("Granola did not complete authorization.");
  }
  const tokenEndpoint = session.discovery?.authorizationServerMetadata?.token_endpoint;
  if (!tokenEndpoint) return yield* failure("Granola did not report an OAuth token endpoint.");
  const now = yield* Clock.currentTimeMillis;
  return {
    issueTracker: "granola",
    organization: account,
    actorUserId: account,
    oauthClientId: session.client.client_id,
    oauthTokenEndpoint: tokenEndpoint,
    oauthResource: session.discovery?.resourceMetadata?.resource ?? config.endpoint,
    token: {
      accessToken: Redacted.make(session.tokens.access_token),
      refreshToken: session.tokens.refresh_token ? Redacted.make(session.tokens.refresh_token) : null,
      expiresAtMillis: now + (session.tokens.expires_in ?? 3600) * 1000,
      scopes: session.tokens.scope?.split(" ").filter(Boolean) ?? [],
    },
  };
});

const RefreshResponse = Schema.Struct({
  access_token: Schema.NonEmptyString,
  refresh_token: Schema.optional(Schema.NonEmptyString),
  expires_in: Schema.optional(Schema.Finite.check(Schema.isGreaterThan(0))),
  scope: Schema.optional(Schema.String),
});

const decodeRefreshResponse = Schema.decodeUnknownEffect(RefreshResponse);

const refreshFailure = (account: string, detail: string) =>
  new CredentialStore.CredentialError({
    account,
    message: `Granola token refresh failed: ${detail}`,
    retryable: false,
  });

export const makeTokenRefresh = (client: HttpClient.HttpClient): CredentialStore.TokenRefresh =>
  Effect.fn("granola.oauth.tokenRefresh")(function* (request) {
    if (!request.tokenEndpoint) {
      return yield* refreshFailure(request.account, "the stored grant has no token endpoint");
    }
    const response = yield* client
      .execute(
        HttpClientRequest.post(request.tokenEndpoint).pipe(
          HttpClientRequest.setHeader("accept", "application/json"),
          HttpClientRequest.bodyUrlParams({
            grant_type: "refresh_token",
            client_id: request.clientId,
            refresh_token: Redacted.value(request.refreshToken),
            ...(request.resource ? { resource: request.resource } : {}),
          }),
        ),
      )
      .pipe(
        Effect.mapError(() => refreshFailure(request.account, "the token endpoint could not be reached")),
        Effect.timeout(oauthRequestDeadline),
        Effect.mapError((error) =>
          error._tag === "CredentialError"
            ? error
            : refreshFailure(request.account, `the token endpoint timed out after ${oauthRequestDeadline}`),
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
      refreshToken: tokens.refresh_token ? Redacted.make(tokens.refresh_token) : null,
      expiresAtMillis: now + (tokens.expires_in ?? 3600) * 1000,
      scopes: tokens.scope?.split(" ").filter(Boolean) ?? [],
    };
  });

export const granolaLoginLayer = (
  config: GranolaLoginConfig = { endpoint: "https://mcp.granola.ai/mcp", redirectPort: 63_339 },
  openerLayer: Layer.Layer<BrowserOpener, never, ChildProcessSpawner> = browserOpenerLayer,
) =>
  Layer.effect(
    Granola.GranolaLogin,
    Effect.gen(function* () {
      const opener = yield* BrowserOpener;
      const random = yield* SecureRandom.SecureRandom;
      const fetchFn = yield* FetchHttpClient.Fetch;
      return {
        login: (account: string) =>
          makeLogin(config, account).pipe(
            Effect.provideService(BrowserOpener, opener),
            Effect.provideService(SecureRandom.SecureRandom, random),
            Effect.provideService(FetchHttpClient.Fetch, fetchFn),
          ),
      };
    }),
  ).pipe(Layer.provide(openerLayer));
