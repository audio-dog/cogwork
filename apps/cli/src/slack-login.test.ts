// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as Http from "node:http";
import { Slack } from "@cogwork/engine";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
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

const listen = (server: Http.Server, host = "127.0.0.1") =>
  Effect.callback<void, Error>((resume) => {
    server.once("error", (error) => resume(Effect.fail(error)));
    server.listen(0, host, () => resume(Effect.void));
  });

const close = (server: Http.Server) =>
  Effect.callback<void>((resume) => {
    server.close(() => resume(Effect.void));
  });

const request = (url: string) =>
  Effect.callback<void, Error>((resume) => {
    const outgoing = Http.get(url, (response) => {
      response.resume();
      response.once("end", () => resume(Effect.void));
    });
    outgoing.once("error", (error) => resume(Effect.fail(error)));
  });

const portOf = (server: Http.Server) => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP server address");
  return address.port;
};

const freePort = () =>
  Effect.acquireUseRelease(
    Effect.sync(() => Http.createServer()).pipe(Effect.tap((server) => listen(server, "localhost"))),
    (server) => Effect.succeed(portOf(server)),
    close,
  );

describe("Slack browser login", () => {
  it.live("stores the user grant without a client secret", () =>
    Effect.gen(function* () {
      const tokenRequests: Array<URLSearchParams> = [];
      const server = Http.createServer((request, response) => {
        const chunks: Array<Buffer> = [];
        request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        request.on("end", () => {
          const params = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
          tokenRequests.push(params);
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              ok: true,
              access_token: "slack-access",
              refresh_token: "slack-refresh-1",
              expires_in: 43_200,
              scope: expectedScopes,
              team: { id: "T-STUB" },
              user_id: "U-STUB",
              app_id: "A-STUB",
            }),
          );
        });
      });
      yield* Effect.acquireRelease(listen(server), () => close(server));
      const callbackPort = yield* freePort();
      const endpoint = `http://127.0.0.1:${portOf(server)}/token`;
      const config: SlackLoginConfig = {
        appId: "A-STUB",
        clientId: "client-stub",
        authorizeEndpoint: "https://slack.example/authorize",
        tokenEndpoint: endpoint,
        redirectUri: `http://localhost:${callbackPort}/oauth/callback`,
      };
      const opened: Array<URL> = [];
      const browser = Layer.succeed(BrowserOpener, {
        open: (url: string) =>
          Effect.suspend(() => {
            const authorize = new URL(url);
            opened.push(authorize);
            const redirect = authorize.searchParams.get("redirect_uri") ?? "";
            const state = authorize.searchParams.get("state") ?? "";
            return request(`${redirect}?code=stub-code&state=${encodeURIComponent(state)}`).pipe(
              Effect.orDie,
            );
          }),
      });

      const context = yield* Layer.build(slackLoginLayer(config, browser));
      const credential = yield* Context.get(context, Slack.SlackLogin).login;

      assert.strictEqual(opened[0]?.searchParams.get("scope"), expectedScopes);
      assert.strictEqual(opened[0]?.searchParams.get("code_challenge_method"), "S256");
      assert.strictEqual(credential.organization, "T-STUB");
      assert.strictEqual(credential.actorUserId, "U-STUB");
      assert.strictEqual(Redacted.value(credential.token.accessToken), "slack-access");
      assert.strictEqual(tokenRequests[0]?.get("client_secret"), null);
      assert.strictEqual(tokenRequests[0]?.get("redirect_uri"), config.redirectUri);
      assert.strictEqual((tokenRequests[0]?.get("code_verifier")?.length ?? 0) > 0, true);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(FetchHttpClient.layer, NodeServices.layer))),
  );
});
