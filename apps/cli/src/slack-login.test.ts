import { Slack } from "@cogwork/engine";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import type * as Scope from "effect/Scope";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import type * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { BrowserOpener } from "./login";
import { type SlackLoginConfig, slackLoginLayer } from "./slack-login";

const expectedScopes = [
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
].join(",");

const config: SlackLoginConfig = {
  appId: "A-STUB",
  clientId: "client-stub",
  authorizeEndpoint: "https://slack.example/authorize",
  tokenEndpoint: "https://slack.example/token",
  redirectUri: "http://localhost:39517/oauth/callback",
};

type CallbackApp<E> = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  E,
  HttpServerRequest.HttpServerRequest | Scope.Scope
>;

const signIn = (tokenBody: unknown) =>
  Effect.gen(function* () {
    const tokenRequests: Array<URLSearchParams> = [];
    const tokenEndpoint = HttpClient.make((request) =>
      Effect.sync(() => {
        if (request.body._tag === "Uint8Array") {
          tokenRequests.push(new URLSearchParams(new TextDecoder().decode(request.body.body)));
        }
        return HttpClientResponse.fromWeb(request, Response.json(tokenBody));
      }),
    );
    const served = yield* Deferred.make<CallbackApp<never>>();
    const serve = <E>(app: CallbackApp<E>) => Deferred.succeed(served, Effect.orDie(app)).pipe(Effect.asVoid);
    const callbackServer = Layer.succeed(
      HttpServer.HttpServer,
      HttpServer.make({
        serve,
        address: { _tag: "TcpAddress", hostname: "localhost", port: 39517 },
      }),
    );
    const opened: Array<URL> = [];
    const browser = Layer.succeed(BrowserOpener, {
      open: (url: string) =>
        Effect.suspend(() => {
          const authorize = new URL(url);
          opened.push(authorize);
          const redirect = authorize.searchParams.get("redirect_uri") ?? "";
          const state = authorize.searchParams.get("state") ?? "";
          const callback = new Request(`${redirect}?code=stub-code&state=${encodeURIComponent(state)}`);
          return Deferred.await(served).pipe(
            Effect.flatMap((app) =>
              app.pipe(
                Effect.provideService(
                  HttpServerRequest.HttpServerRequest,
                  HttpServerRequest.fromWeb(callback),
                ),
                Effect.scoped,
              ),
            ),
            Effect.asVoid,
          );
        }),
    });
    const context = yield* Layer.build(
      slackLoginLayer(config, browser, callbackServer).pipe(
        Layer.provide(Layer.succeed(HttpClient.HttpClient, tokenEndpoint)),
      ),
    );
    const result = yield* Effect.result(Context.get(context, Slack.SlackLogin).login);
    return { result, opened, tokenRequests };
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const identity = {
  ok: true,
  team: { id: "T-STUB" },
  authed_user: { id: "U-STUB", scope: expectedScopes },
};

const rotatingToken = { access_token: "slack-access", refresh_token: "slack-refresh-1", expires_in: 43_200 };

describe("Slack browser login", () => {
  it.live("stores the user grant without a client secret", () =>
    Effect.gen(function* () {
      const { result, opened, tokenRequests } = yield* signIn({ ...identity, ...rotatingToken });
      assert.isTrue(Result.isSuccess(result));
      if (Result.isFailure(result)) return;
      const credential = result.success;

      assert.strictEqual(opened[0]?.searchParams.get("scope"), expectedScopes);
      assert.strictEqual(opened[0]?.searchParams.get("code_challenge_method"), "S256");
      assert.strictEqual(credential.organization, "T-STUB");
      assert.strictEqual(credential.actorUserId, "U-STUB");
      assert.strictEqual(Redacted.value(credential.token.accessToken), "slack-access");
      assert.deepStrictEqual(credential.token.scopes, expectedScopes.split(","));
      assert.strictEqual(tokenRequests[0]?.get("client_secret"), null);
      assert.strictEqual(tokenRequests[0]?.get("redirect_uri"), config.redirectUri);
      assert.strictEqual((tokenRequests[0]?.get("code_verifier")?.length ?? 0) > 0, true);
    }),
  );

  it.live("stores a rotating user token nested under authed_user", () =>
    Effect.gen(function* () {
      const { result } = yield* signIn({
        ...identity,
        authed_user: { ...identity.authed_user, ...rotatingToken, token_type: "user" },
      });
      assert.isTrue(Result.isSuccess(result));
      if (Result.isFailure(result)) return;
      assert.strictEqual(Redacted.value(result.success.token.accessToken), "slack-access");
      assert.strictEqual(
        result.success.token.refreshToken && Redacted.value(result.success.token.refreshToken),
        "slack-refresh-1",
      );
    }),
  );

  it.live("reports the error Slack returns", () =>
    Effect.gen(function* () {
      const { result } = yield* signIn({ ok: false, error: "invalid_code" });
      assert.isTrue(Result.isFailure(result));
      if (Result.isSuccess(result)) return;
      assert.strictEqual(result.failure.message, "Slack token exchange failed: invalid_code");
    }),
  );

  it.live("asks for token rotation when Slack returns no refresh token", () =>
    Effect.gen(function* () {
      const { result } = yield* signIn({ ...identity, access_token: "xoxp-long-lived", token_type: "user" });
      assert.isTrue(Result.isFailure(result));
      if (Result.isSuccess(result)) return;
      assert.include(result.failure.message, "turn on token rotation");
    }),
  );
});
