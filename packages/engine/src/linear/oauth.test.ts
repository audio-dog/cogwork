import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import {
  authorizeUrl,
  codeChallenge,
  decodeDiscovery,
  decodeTokenResponse,
  makePkce,
  makeState,
  redirectUri,
  storedTokenFrom,
  tokenExchangeRequest,
} from "./oauth";

const cryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => Uint8Array.from({ length: size }, (_, index) => index),
    digest: (algorithm, data) =>
      Effect.map(
        Effect.promise(() => globalThis.crypto.subtle.digest(algorithm, Uint8Array.from(data))),
        (buffer) => new Uint8Array(buffer),
      ),
  }),
);

const withCrypto = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provide(effect, cryptoLayer);

const tokenBody = {
  access_token: "linear-access-token",
  token_type: "Bearer",
  expires_in: 86_399,
  scope: "read write",
  refresh_token: "linear-refresh-token",
};

describe("linear oauth helpers", () => {
  it.effect("derives the RFC 7636 code challenge from a verifier", () =>
    Effect.gen(function* () {
      const challenge = yield* codeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
      assert.strictEqual(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }).pipe(withCrypto),
  );

  it.effect("generates an unpadded 43-character verifier and its challenge", () =>
    Effect.gen(function* () {
      const pkce = yield* makePkce();
      assert.strictEqual(pkce.verifier.length, 43);
      assert.notMatch(pkce.verifier, /[+/=]/);
      assert.strictEqual(pkce.challenge, yield* codeChallenge(pkce.verifier));
    }).pipe(withCrypto),
  );

  it.effect("builds an authorize url carrying the PKCE challenge and state", () =>
    Effect.gen(function* () {
      const state = yield* makeState();
      assert.strictEqual(state.length, 22);
      const url = new URL(
        authorizeUrl({
          clientId: "client-1",
          redirectUri: redirectUri(39_517),
          state,
          challenge: "challenge-1",
          scopes: ["read", "write"],
        }),
      );
      assert.strictEqual(url.origin + url.pathname, "https://linear.app/oauth/authorize");
      assert.deepStrictEqual(Object.fromEntries(url.searchParams), {
        response_type: "code",
        client_id: "client-1",
        redirect_uri: "http://localhost:39517/oauth/callback",
        scope: "read,write",
        state,
        code_challenge: "challenge-1",
        code_challenge_method: "S256",
        actor: "app",
        prompt: "consent",
      });
    }).pipe(withCrypto),
  );

  it("builds a form-encoded token exchange request without a client secret", () => {
    const exchange = tokenExchangeRequest({
      clientId: "client-1",
      redirectUri: redirectUri(39_517),
      code: "auth-code",
      verifier: "verifier-1",
    });
    assert.strictEqual(exchange.url, "https://api.linear.app/oauth/token");
    assert.strictEqual(exchange.method, "POST");
    assert.strictEqual(exchange.headers["content-type"], "application/x-www-form-urlencoded");
    assert.deepStrictEqual(Object.fromEntries(new URLSearchParams(exchange.body)), {
      grant_type: "authorization_code",
      client_id: "client-1",
      redirect_uri: "http://localhost:39517/oauth/callback",
      code: "auth-code",
      code_verifier: "verifier-1",
    });
  });

  it.effect("decodes a token response and converts it to a stored token", () =>
    Effect.gen(function* () {
      const response = yield* decodeTokenResponse(tokenBody);
      const token = storedTokenFrom(response, 1_000);
      assert.strictEqual(Redacted.value(token.accessToken), "linear-access-token");
      assert.strictEqual(token.refreshToken && Redacted.value(token.refreshToken), "linear-refresh-token");
      assert.strictEqual(token.expiresAtMillis, 1_000 + 86_399_000);
      assert.deepStrictEqual(token.scopes, ["read", "write"]);
    }),
  );

  it.effect("decodes the legacy array form of the scope field", () =>
    Effect.gen(function* () {
      const response = yield* decodeTokenResponse({ ...tokenBody, scope: ["read", "write"] });
      assert.deepStrictEqual(storedTokenFrom(response, 0).scopes, ["read", "write"]);
    }),
  );

  it.effect("treats a token response without a refresh token as having none", () =>
    Effect.gen(function* () {
      const { refresh_token: _omitted, ...body } = tokenBody;
      const response = yield* decodeTokenResponse(body);
      assert.strictEqual(storedTokenFrom(response, 0).refreshToken, null);
    }),
  );

  it.effect("rejects a token response missing an access token", () =>
    Effect.gen(function* () {
      const { access_token: _omitted, ...body } = tokenBody;
      yield* Effect.flip(decodeTokenResponse(body));
    }),
  );

  it.effect("decodes the organization and bot user id from a discovery response", () =>
    Effect.gen(function* () {
      const discovery = yield* decodeDiscovery({
        data: {
          viewer: { id: "bot-user" },
          organization: { id: "org-uuid", name: "Acme", urlKey: "acme" },
        },
      });
      assert.strictEqual(discovery.data.viewer.id, "bot-user");
      assert.strictEqual(discovery.data.organization.urlKey, "acme");
    }),
  );

  it.effect("rejects a discovery response without a viewer", () =>
    Effect.flip(decodeDiscovery({ data: { organization: { id: "o", name: "Acme", urlKey: "acme" } } })),
  );
});
