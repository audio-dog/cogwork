// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as Http from "node:http";
import { CredentialStore, Linear, Providers } from "@cogwork/engine";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

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
  if (process.platform === "win32") return ChildProcess.make("cmd", ["/c", "start", "", url]);
  return ChildProcess.make("xdg-open", [url]);
};

export const browserOpenerLayer = Layer.effect(
  BrowserOpener,
  Effect.map(
    ChildProcessSpawner,
    (spawner): BrowserOpenerService => ({
      open: (url) =>
        spawner.exitCode(openCommand(url)).pipe(
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
                message: `Opening the browser timed out after ${browserOpenDeadline}; retry cogwork login linear.`,
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

const successPage = resultPage(
  "Linear login complete",
  "You can close this window and return to the terminal.",
);
const failurePage = resultPage("Linear login failed", "Return to the terminal for details.");

const callbackApp = (result: Deferred.Deferred<CallbackParams>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = new URL(request.url, "http://localhost");
    if (url.pathname !== "/oauth/callback") return HttpServerResponse.empty({ status: 404 });
    const params = {
      code: url.searchParams.get("code"),
      state: url.searchParams.get("state"),
      error: url.searchParams.get("error"),
    } satisfies CallbackParams;
    yield* Deferred.succeed(result, params);
    const settled = params.error !== null || params.code === null;
    return HttpServerResponse.html(settled ? failurePage : successPage);
  });

const redirectUriFor = (redirectPort: number) => Linear.OAuth.redirectUri(redirectPort);

const awaitAuthorization = Effect.fn("cli.login.awaitAuthorization")(
  function* (config: LinearLoginConfig, authorizeUrl: string, expectedState: string, verifier: string) {
    const result = yield* Deferred.make<CallbackParams>();
    yield* HttpServer.serveEffect(callbackApp(result));
    const opener = yield* BrowserOpener;
    const callback = yield* Deferred.await(result).pipe(
      Effect.timeout(callbackDeadline),
      Effect.catchTag(
        "TimeoutError",
        () =>
          new LinearOAuthError({
            message: `Linear login timed out waiting for the browser callback after ${callbackDeadline}; retry cogwork login linear.`,
          }),
      ),
      Effect.raceFirst(opener.open(authorizeUrl).pipe(Effect.andThen(Deferred.await(result)))),
    );
    if (callback.error !== null) {
      return yield* new LinearOAuthError({
        message: `Linear denied the authorization ("${callback.error}"). Confirm ${redirectUriFor(config.redirectPort)} is a registered redirect URL for this OAuth app.`,
      });
    }
    if (callback.state !== expectedState) {
      return yield* new LinearOAuthError({
        message:
          "The authorization response carried the wrong state; discarding it and not exchanging a token.",
      });
    }
    if (callback.code === null) {
      return yield* new LinearOAuthError({
        message: "Linear's redirect did not include an authorization code.",
      });
    }
    return yield* Linear.OAuth.exchangeToken({
      clientId: config.clientId,
      redirectUri: redirectUriFor(config.redirectPort),
      code: callback.code,
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
