// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as Http from "node:http";
import { CredentialStore, Linear, Providers } from "@cogwork/engine";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as ChildProcess from "effect/process/ChildProcess";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as Redacted from "effect/Redacted";

const { LinearOAuthError } = Linear.OAuth;

const browserOpenDeadline = "30 seconds";
const callbackDeadline = "5 minutes";

export interface LinearLoginConfig {
  readonly clientId: string;
  readonly redirectPort: number;
  readonly expectedOrganization?: string;
}

export interface LinearLoginResult {
  readonly organization: string;
  readonly actorUserId: string;
}

export interface BrowserOpenerService {
  readonly open: (url: string) => Effect.Effect<void, Linear.OAuth.LinearOAuthError>;
}

export class BrowserOpener extends Context.Service<BrowserOpener, BrowserOpenerService>()(
  "@cogwork/cli/login/BrowserOpener",
) {}

const openCommand = (url: string) => {
  if (process.platform === "darwin") return ChildProcess.make("open", [url]);
  if (process.platform === "win32")
    return ChildProcess.make("rundll32.exe", ["url.dll,FileProtocolHandler", url]);
  return ChildProcess.make("xdg-open", [url]);
};

const authorizationUrl = (value: string) =>
  Effect.try({
    try: () => new URL(value),
    catch: () => new LinearOAuthError({ message: "The authorization server returned an invalid URL." }),
  }).pipe(
    Effect.filterOrFail(
      (url) => url.protocol === "https:",
      () => new LinearOAuthError({ message: "The authorization server returned a non-HTTPS URL." }),
    ),
  );

export const browserOpenerLayer = Layer.effect(
  BrowserOpener,
  Effect.map(
    ChildProcessSpawner,
    (spawner): BrowserOpenerService => ({
      open: (url) =>
        authorizationUrl(url).pipe(
          Effect.flatMap((safeUrl) => spawner.exitCode(openCommand(safeUrl.href))),
          Effect.asVoid,
          Effect.mapError(
            (cause) =>
              new LinearOAuthError({ message: `could not open a browser for ${url}: ${cause.message}` }),
          ),
          Effect.timeout(browserOpenDeadline),
          Effect.catchTag(
            "TimeoutError",
            () =>
              new LinearOAuthError({
                message: `Opening the browser timed out after ${browserOpenDeadline}; retry the login.`,
              }),
          ),
        ),
    }),
  ),
);

interface CallbackParams {
  readonly code: string | null;
  readonly state: string | null;
  readonly error: string | null;
}

const resultPage = (heading: string, detail: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>cogwork</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1>${heading}</h1><p>${detail}</p></body></html>`;

const callbackApp = (result: Deferred.Deferred<CallbackParams>, expectedState: string, loginName: string) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = new URL(request.url, "http://localhost");
    if (url.pathname !== "/oauth/callback") return HttpServerResponse.empty({ status: 404 });
    const params = {
      code: url.searchParams.get("code"),
      state: url.searchParams.get("state"),
      error: url.searchParams.get("error"),
    } satisfies CallbackParams;
    if (params.state !== expectedState) {
      return HttpServerResponse.text(
        resultPage(`${loginName} login failed`, "The authorization response had an invalid state."),
        { status: 400, contentType: "text/html; charset=utf-8" },
      );
    }
    yield* Deferred.succeed(result, params);
    const settled = params.error !== null || params.code === null;
    return HttpServerResponse.html(
      settled
        ? resultPage(`${loginName} login failed`, "Return to Cogwork for details.")
        : resultPage(`${loginName} login complete`, "You can close this window and return to Cogwork."),
    );
  });

export class LoopbackAuthorizationError extends Data.TaggedError("LoopbackAuthorizationError")<{
  readonly message: string;
}> {}

export interface LoopbackAuthorizationConfig {
  readonly authorizationUrl: URL;
  readonly expectedState: string;
  readonly loginName: string;
}

export const awaitLoopbackAuthorization = Effect.fn("cli.login.awaitLoopbackAuthorization")(function* (
  config: LoopbackAuthorizationConfig,
) {
  const result = yield* Deferred.make<CallbackParams>();
  yield* HttpServer.serveEffect(callbackApp(result, config.expectedState, config.loginName));
  const opener = yield* BrowserOpener;
  const callback = yield* Deferred.await(result).pipe(
    Effect.timeout(callbackDeadline),
    Effect.mapError(
      () =>
        new LoopbackAuthorizationError({
          message: `${config.loginName} login timed out waiting for the browser callback; retry.`,
        }),
    ),
    Effect.raceFirst(
      opener.open(config.authorizationUrl.href).pipe(
        Effect.mapError((error) => new LoopbackAuthorizationError({ message: error.message })),
        Effect.andThen(Deferred.await(result)),
      ),
    ),
  );
  if (callback.error !== null) {
    return yield* new LoopbackAuthorizationError({
      message: `${config.loginName} denied the authorization ("${callback.error}").`,
    });
  }
  if (callback.code === null) {
    return yield* new LoopbackAuthorizationError({
      message: `${config.loginName} did not return an authorization code.`,
    });
  }
  return callback.code;
});

const redirectUriFor = (redirectPort: number) => Linear.OAuth.redirectUri(redirectPort);

const awaitAuthorization = Effect.fn("cli.login.awaitAuthorization")(
  function* (config: LinearLoginConfig, authorizeUrl: string, expectedState: string, verifier: string) {
    const code = yield* awaitLoopbackAuthorization({
      authorizationUrl: new URL(authorizeUrl),
      expectedState,
      loginName: "Linear",
    }).pipe(Effect.mapError((error) => new LinearOAuthError({ message: error.message })));
    return yield* Linear.OAuth.exchangeToken({
      clientId: config.clientId,
      redirectUri: redirectUriFor(config.redirectPort),
      code,
      verifier,
    });
  },
  (effect, config) =>
    effect.pipe(
      Effect.provide(NodeHttpServer.layer(Http.createServer, { port: config.redirectPort })),
      Effect.scoped,
      Effect.catchTag("ServeError", () =>
        Effect.fail(
          new LinearOAuthError({
            message: `Could not start the loopback server on port ${config.redirectPort}. Another login may be running, or the port is in use.`,
          }),
        ),
      ),
    ),
);

export class ProviderKeyError extends Data.TaggedError("ProviderKeyError")<{
  readonly message: string;
}> {}

export interface KeyLoginResult {
  readonly provider: string;
  readonly displayName: string;
}

export const loginKey = Effect.fn("cli.login.key")(function* (input: {
  readonly provider: string;
  readonly key: string;
}) {
  const provider = Providers.findProvider(input.provider);
  if (!provider) {
    return yield* new ProviderKeyError({
      message: `unknown provider "${input.provider}"; known providers: ${Providers.supportedProviders.map((entry) => entry.id).join(", ")}`,
    });
  }
  const trimmed = input.key.trim();
  if (trimmed === "") {
    return yield* new ProviderKeyError({ message: `no api key provided for ${provider.displayName}` });
  }
  const store = yield* CredentialStore.CredentialStore;
  yield* store.persistProviderKey({ provider: provider.id, key: Redacted.make(trimmed) });
  yield* Effect.logInfo("stored provider key", { provider: provider.id });
  return { provider: provider.id, displayName: provider.displayName } satisfies KeyLoginResult;
});

export const loginLinear = Effect.fn("cli.login.linear")(function* (config: LinearLoginConfig) {
  const pkce = yield* Linear.OAuth.makePkce();
  const state = yield* Linear.OAuth.makeState();
  const authorizeUrl = Linear.OAuth.authorizeUrl({
    clientId: config.clientId,
    redirectUri: redirectUriFor(config.redirectPort),
    state,
    challenge: pkce.challenge,
  });
  yield* Effect.logInfo("opening Linear authorization in the browser", { redirectPort: config.redirectPort });
  const tokenResponse = yield* awaitAuthorization(config, authorizeUrl, state, pkce.verifier);
  const now = yield* Clock.currentTimeMillis;
  const token = Linear.OAuth.storedTokenFrom(tokenResponse, now);
  const identity = yield* Linear.OAuth.discoverIdentity(tokenResponse.access_token);
  if (config.expectedOrganization !== undefined && config.expectedOrganization !== identity.organization) {
    return yield* new LinearOAuthError({
      message: `The Linear Connection is established for "${config.expectedOrganization}". Remove it before logging in to "${identity.organization}".`,
    });
  }
  const store = yield* CredentialStore.CredentialStore;
  yield* store.persist({
    issueTracker: "linear",
    organization: identity.organization,
    actorUserId: identity.actorUserId,
    oauthClientId: config.clientId,
    token,
  });
  yield* Effect.logInfo("stored Linear credential", {
    organization: identity.organization,
    actorUserId: identity.actorUserId,
  });
  return {
    organization: identity.organization,
    actorUserId: identity.actorUserId,
  } satisfies LinearLoginResult;
});
