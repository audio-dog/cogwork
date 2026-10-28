// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as Http from "node:http";
import { Granola } from "@cogwork/engine";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { type GranolaLoginConfig, granolaLoginLayer, makeTokenRefresh } from "./granola-login";
import { BrowserOpener } from "./login";

const listen = (server: Http.Server) =>
  Effect.callback<void, Error>((resume) => {
    server.once("error", (error) => resume(Effect.fail(error)));
    server.listen(0, "127.0.0.1", () => resume(Effect.void));
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
    Effect.sync(() => Http.createServer()).pipe(Effect.tap(listen)),
    (server) => Effect.succeed(portOf(server)),
    close,
  );

describe("Granola browser login", () => {
  it.live("registers dynamically, catches the loopback callback, and returns tokens", () =>
    Effect.gen(function* () {
      const registrations: Array<unknown> = [];
      const refreshRequests: Array<URLSearchParams> = [];
      const server = Http.createServer((request, response) => {
        const base = `http://127.0.0.1:${portOf(server)}`;
        const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
          response.writeHead(status, { "content-type": "application/json", ...headers });
          response.end(JSON.stringify(body));
        };
        const readBody = (onBody: (body: string) => void) => {
          const chunks: Array<Buffer> = [];
          request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          request.on("end", () => onBody(Buffer.concat(chunks).toString("utf8")));
        };
        const routes = new Map<string, () => void>([
          [
            "GET /mcp",
            () => send(401, {}, { "www-authenticate": `Bearer resource_metadata="${base}/resource"` }),
          ],
          [
            "GET /resource",
            () =>
              send(200, {
                resource: `${base}/mcp`,
                authorization_servers: [base],
                scopes_supported: ["mcp"],
              }),
          ],
          [
            "GET /.well-known/oauth-authorization-server",
            () =>
              send(200, {
                issuer: base,
                authorization_endpoint: `${base}/authorize`,
                token_endpoint: `${base}/token`,
                registration_endpoint: `${base}/register`,
                response_types_supported: ["code"],
                grant_types_supported: ["authorization_code", "refresh_token"],
                code_challenge_methods_supported: ["S256"],
                token_endpoint_auth_methods_supported: ["none"],
              }),
          ],
          [
            "POST /register",
            () =>
              readBody((body) => {
                const registration = JSON.parse(body);
                registrations.push(registration);
                send(201, { ...registration, client_id: "granola-client" });
              }),
          ],
          [
            "POST /token",
            () =>
              readBody((body) => {
                const params = new URLSearchParams(body);
                const refreshing = params.get("grant_type") === "refresh_token";
                if (refreshing) refreshRequests.push(params);
                send(200, {
                  access_token: refreshing ? "granola-refreshed" : "granola-access",
                  refresh_token: refreshing ? undefined : "granola-refresh",
                  token_type: "Bearer",
                  expires_in: 3600,
                  scope: "mcp",
                });
              }),
          ],
        ]);
        return (routes.get(`${request.method} ${request.url}`) ?? (() => send(404, {})))();
      });
      yield* Effect.acquireRelease(listen(server), () => close(server));
      const callbackPort = yield* freePort();
      const config: GranolaLoginConfig = {
        endpoint: `http://127.0.0.1:${portOf(server)}/mcp`,
        redirectPort: callbackPort,
      };
      const browser = Layer.succeed(BrowserOpener, {
        open: (url: string) =>
          Effect.suspend(() => {
            const authorize = new URL(url);
            const redirect = authorize.searchParams.get("redirect_uri") ?? "";
            const state = authorize.searchParams.get("state") ?? "";
            return request(`${redirect}?error=access_denied&state=wrong-state`).pipe(
              Effect.andThen(request(`${redirect}?code=stub-code&state=${encodeURIComponent(state)}`)),
              Effect.orDie,
            );
          }),
      });

      const loginContext = yield* Layer.build(granolaLoginLayer(config, browser));
      const login = Context.get(loginContext, Granola.GranolaLogin);
      const credential = yield* login.login("person@example.com");

      assert.strictEqual(registrations.length, 1);
      assert.strictEqual(credential.oauthClientId, "granola-client");
      assert.strictEqual(credential.oauthTokenEndpoint, `${config.endpoint.replace("/mcp", "/token")}`);
      assert.strictEqual(credential.organization, "person@example.com");
      assert.strictEqual(Redacted.value(credential.token.accessToken), "granola-access");
      if (!credential.token.refreshToken) assert.fail("Expected refresh token");
      assert.strictEqual(Redacted.value(credential.token.refreshToken), "granola-refresh");
      const http = yield* HttpClient.HttpClient;
      const refreshed = yield* makeTokenRefresh(http)({
        account: "granola/person@example.com",
        issueTracker: "granola",
        clientId: credential.oauthClientId ?? "",
        tokenEndpoint: credential.oauthTokenEndpoint,
        resource: credential.oauthResource,
        refreshToken: credential.token.refreshToken,
      });

      assert.strictEqual(Redacted.value(refreshed.accessToken), "granola-refreshed");
      assert.strictEqual(refreshRequests[0]?.get("client_id"), "granola-client");
      assert.strictEqual(refreshRequests[0]?.get("resource"), `${baseOf(config.endpoint)}/mcp`);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(FetchHttpClient.layer, NodeServices.layer))),
  );
});

const baseOf = (url: string) => new URL(url).origin;
