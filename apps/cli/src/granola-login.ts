// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as Http from "node:http";
import { ConnectionFailure } from "@cogwork/contracts";
import { Granola } from "@cogwork/engine";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { BrowserOpener, browserOpenerLayer } from "./login";

const callbackDeadline = "5 minutes";

export interface GranolaLoginConfig {
  readonly endpoint: string;
  readonly redirectPort: number;
}

const failure = (message: string) =>
  new ConnectionFailure({ operation: "login Granola", connectionId: null, message });

interface CallbackParams {
  readonly code: string | null;
  readonly state: string | null;
  readonly error: string | null;
}

const callbackApp = (result: Deferred.Deferred<CallbackParams>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname !== "/oauth/callback") return HttpServerResponse.empty({ status: 404 });
    const params = {
      code: url.searchParams.get("code"),
      state: url.searchParams.get("state"),
      error: url.searchParams.get("error"),
    } satisfies CallbackParams;
    yield* Deferred.succeed(result, params);
    const successful = params.error === null && params.code !== null;
    return HttpServerResponse.html(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>cogwork</title></head><body><h1>Granola login ${successful ? "complete" : "failed"}</h1><p>Return to Cogwork.</p></body></html>`,
    );
  });

const redirectUri = (port: number) => `http://127.0.0.1:${port}/oauth/callback`;

const runAuth = (provider: OAuthClientProvider, endpoint: string, authorizationCode?: string) =>
  Effect.tryPromise({
    try: () => auth(provider, { serverUrl: endpoint, authorizationCode }),
    catch: (error) => failure(error instanceof Error ? error.message : String(error)),
  });

const awaitCallback = (authorizationUrl: URL, expectedState: string) =>
  Effect.gen(function* () {
    const result = yield* Deferred.make<CallbackParams>();
    yield* HttpServer.serveEffect(callbackApp(result));
    const opener = yield* BrowserOpener;
    const callback = yield* Deferred.await(result).pipe(
      Effect.timeout(callbackDeadline),
      Effect.mapError(() => failure("Granola login timed out waiting for the browser callback.")),
      Effect.raceFirst(
        opener.open(authorizationUrl.href).pipe(
          Effect.mapError((error) => failure(error.message)),
          Effect.andThen(Deferred.await(result)),
        ),
      ),
    );
    if (callback.error) return yield* failure(`Granola denied authorization: ${callback.error}`);
    if (callback.state !== expectedState) return yield* failure("Granola returned the wrong OAuth state.");
    if (!callback.code) return yield* failure("Granola did not return an authorization code.");
    return callback.code;
  });

export const makeLogin = Effect.fn("granola.login")(function* (config: GranolaLoginConfig, account: string) {
  const crypto = yield* Crypto.Crypto;
  const state = Encoding.encodeBase64Url(
    yield* crypto
      .randomBytes(16)
      .pipe(Effect.mapError(() => failure("Could not create a secure Granola OAuth state."))),
  );
  const callback = redirectUri(config.redirectPort);
  const opener = yield* BrowserOpener;
  const session: {
    client?: OAuthClientInformationMixed;
    tokens?: OAuthTokens;
    verifier?: string;
    authorizationUrl?: URL;
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
  };
  const first = yield* runAuth(provider, config.endpoint);
  if (first !== "REDIRECT" || !session.authorizationUrl) {
    return yield* failure("Granola did not start browser authorization.");
  }
  const code = yield* awaitCallback(session.authorizationUrl, state).pipe(
    Effect.provideService(BrowserOpener, opener),
    Effect.provide(NodeHttpServer.layer(Http.createServer, { host: "127.0.0.1", port: config.redirectPort })),
    Effect.scoped,
    Effect.mapError((error) =>
      error._tag === "ConnectionFailure"
        ? error
        : failure(`Could not start the Granola callback server on 127.0.0.1:${config.redirectPort}.`),
    ),
  );
  const completed = yield* runAuth(provider, config.endpoint, code);
  if (completed !== "AUTHORIZED" || !session.tokens || !session.client) {
    return yield* failure("Granola did not complete authorization.");
  }
  const now = yield* Clock.currentTimeMillis;
  return {
    issueTracker: "granola",
    organization: account,
    actorUserId: account,
    oauthClientId: session.client.client_id,
    token: {
      accessToken: Redacted.make(session.tokens.access_token),
      refreshToken: session.tokens.refresh_token ? Redacted.make(session.tokens.refresh_token) : null,
      expiresAtMillis: now + (session.tokens.expires_in ?? 3600) * 1000,
      scopes: session.tokens.scope?.split(" ").filter(Boolean) ?? [],
    },
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
      const crypto = yield* Crypto.Crypto;
      return {
        login: (account: string) =>
          makeLogin(config, account).pipe(
            Effect.provideService(BrowserOpener, opener),
            Effect.provideService(Crypto.Crypto, crypto),
          ),
      };
    }),
  ).pipe(Layer.provide(openerLayer));
