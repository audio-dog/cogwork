import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { TestClock } from "effect/testing";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { afterEach, vi } from "vitest";
import {
  authorizeUrl,
  clientCredentialsRequest,
  codeChallenge,
  decodeTokenResponse,
  discoverIdentity,
  exchangeToken,
  makePkce,
  makeState,
  makeTokenRefresh,
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

interface StubResponse {
  readonly status?: number;
  readonly body: unknown;
}

const documentOf = (init: RequestInit | undefined) => {
  const body = init?.body;
  if (typeof body !== "string") return "";
  const parsed: { readonly query?: string } = JSON.parse(body);
  return parsed.query ?? "";
};

const formBodyOf = (init: RequestInit | undefined) => {
  const body = init?.body;
  if (typeof body === "string") return body;
  return body instanceof Uint8Array ? new TextDecoder().decode(body) : "";
};

const jsonResponse = ({ status = 200, body }: StubResponse) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// The Fetch reference resolves `globalThis.fetch` once and keeps it, so a stubbed global would leak
// the first test's routing into every later one; the reference has to carry the stub instead.
const tokenEndpoint = (route: () => StubResponse) => {
  const sent: Array<string> = [];
  const fetch: typeof globalThis.fetch = (_input, init) => {
    sent.push(formBodyOf(init));
    return Promise.resolve(jsonResponse(route()));
  };
  return { fetch, sentBody: () => sent.at(-1) ?? "" };
};

const withTokenEndpoint =
  (stub: ReturnType<typeof tokenEndpoint>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, stub.fetch),
    );

const stubLinear = (route: (document: string) => StubResponse) => {
  vi.stubGlobal(
    "fetch",
    vi.fn((_input: unknown, init?: RequestInit) => {
      const { status = 200, body } = route(documentOf(init));
      return Promise.resolve(
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
      );
    }),
  );
};

describe("linear oauth helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

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

  const refresh = (refreshToken: string) =>
    Effect.flatMap(HttpClient.HttpClient, (client) =>
      makeTokenRefresh(client)({
        account: "AUD",
        clientId: "client-1",
        refreshToken: Redacted.make(refreshToken),
      }),
    );

  it.effect("exchanges a refresh token for a rotated pair", () => {
    const endpoint = tokenEndpoint(() => ({ body: tokenBody }));
    return Effect.gen(function* () {
      const token = yield* refresh("refresh-1");
      assert.deepStrictEqual(Object.fromEntries(new URLSearchParams(endpoint.sentBody())), {
        grant_type: "refresh_token",
        client_id: "client-1",
        refresh_token: "refresh-1",
      });
      assert.strictEqual(Redacted.value(token.accessToken), "linear-access-token");
      assert.strictEqual(token.refreshToken && Redacted.value(token.refreshToken), "linear-refresh-token");
    }).pipe(withTokenEndpoint(endpoint));
  });

  it.effect("reports a rejected refresh without quoting the refresh token", () => {
    const endpoint = tokenEndpoint(() => ({ status: 400, body: { error: "invalid_grant" } }));
    return Effect.gen(function* () {
      const error = yield* Effect.flip(refresh("super-secret-refresh"));
      assert.strictEqual(error.account, "AUD");
      assert.include(error.message, "400");
      assert.notInclude(error.message, "super-secret-refresh");
    }).pipe(withTokenEndpoint(endpoint));
  });

  it.effect("fails a hanging refresh at the token endpoint deadline", () => {
    const onAbort = vi.fn();
    const fetch: typeof globalThis.fetch = (_input, init) => {
      init?.signal?.addEventListener("abort", onAbort);
      return Promise.withResolvers<Response>().promise;
    };
    return Effect.gen(function* () {
      const requestFiber = yield* Effect.forkChild(Effect.flip(refresh("refresh-1")));
      yield* TestClock.adjust("1 minute");
      const error = yield* Fiber.join(requestFiber);
      assert.strictEqual(error.account, "AUD");
      assert.include(error.message, "timed out");
      assert.strictEqual(onAbort.mock.calls.length, 1);
    }).pipe(Effect.provide(FetchHttpClient.layer), Effect.provideService(FetchHttpClient.Fetch, fetch));
  });

  it.effect("rejects a token response the schema does not accept", () => {
    const endpoint = tokenEndpoint(() => ({ body: { token_type: "Bearer" } }));
    return Effect.gen(function* () {
      const error = yield* Effect.flip(refresh("refresh-1"));
      assert.include(error.message, "unexpected payload");
    }).pipe(withTokenEndpoint(endpoint));
  });

  it("builds a form-encoded client-credentials request carrying the secret", () => {
    const grant = clientCredentialsRequest({
      clientId: "client-1",
      clientSecret: Redacted.make("s3cret"),
      scopes: ["read", "write"],
    });
    assert.strictEqual(grant.url, "https://api.linear.app/oauth/token");
    assert.strictEqual(grant.method, "POST");
    assert.deepStrictEqual(Object.fromEntries(new URLSearchParams(grant.body)), {
      grant_type: "client_credentials",
      client_id: "client-1",
      client_secret: "s3cret",
      scope: "read,write",
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

  const exchangeParams = {
    clientId: "client-1",
    redirectUri: redirectUri(39_517),
    code: "auth-code",
    verifier: "verifier-1",
  };

  const bodyText = (body: BodyInit | null | undefined) =>
    typeof body === "string" ? body : body instanceof Uint8Array ? new TextDecoder().decode(body) : "";

  const withFetch =
    (impl: typeof globalThis.fetch) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.provide(FetchHttpClient.layer), Effect.provideService(FetchHttpClient.Fetch, impl));

  it.effect("posts the code and decodes the token pair Linear returns", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly body: string }> = [];
      const response = yield* exchangeToken(exchangeParams).pipe(
        withFetch((input, init) => {
          calls.push({ url: String(input), body: bodyText(init?.body) });
          return Promise.resolve(
            new Response(JSON.stringify(tokenBody), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        }),
      );
      assert.strictEqual(response.access_token, "linear-access-token");
      assert.strictEqual(calls[0]?.url, "https://api.linear.app/oauth/token");
      assert.include(calls[0]?.body ?? "", "code=auth-code");
    }),
  );

  it.effect("reports a clear error when Linear rejects the token exchange", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        exchangeToken(exchangeParams).pipe(
          withFetch(() => Promise.resolve(new Response("denied", { status: 400 }))),
        ),
      );
      assert.include(error.message, "HTTP 400");
    }),
  );

  it.effect("fails a hanging token exchange at the token endpoint deadline", () =>
    Effect.gen(function* () {
      const onAbort = vi.fn();
      const requestFiber = yield* Effect.forkChild(
        Effect.flip(
          exchangeToken(exchangeParams).pipe(
            withFetch((_input, init) => {
              init?.signal?.addEventListener("abort", onAbort);
              return Promise.withResolvers<Response>().promise;
            }),
          ),
        ),
      );
      yield* TestClock.adjust("1 minute");
      const error = yield* Fiber.join(requestFiber);
      assert.include(error.message, "timed out");
      assert.strictEqual(onAbort.mock.calls.length, 1);
    }),
  );

  it.effect("discovers the organization's urlKey and the viewer's id via the SDK", () =>
    Effect.gen(function* () {
      stubLinear((document) =>
        document.includes("query viewer")
          ? { body: { data: { viewer: { id: "bot-user" } } } }
          : {
              body: {
                data: {
                  organization: {
                    id: "org-uuid",
                    name: "Acme",
                    urlKey: "acme",
                    projectStatuses: [],
                  },
                },
              },
            },
      );
      const identity = yield* discoverIdentity("access-token");
      assert.deepStrictEqual(identity, { organization: "acme", actorUserId: "bot-user" });
    }),
  );

  it.effect("fails when Linear rejects the discovery request", () =>
    Effect.gen(function* () {
      stubLinear(() => ({ status: 401, body: { errors: [{ message: "not authorized" }] } }));
      const error = yield* Effect.flip(discoverIdentity("bad-token"));
      assert.include(error.message, "identity discovery failed");
    }),
  );

  it.effect("aborts identity discovery at its deadline", () =>
    Effect.gen(function* () {
      const signals: Array<AbortSignal> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn((_input: unknown, init?: RequestInit) => {
          if (init?.signal) signals.push(init.signal);
          return Promise.withResolvers<Response>().promise;
        }),
      );
      const requestFiber = yield* Effect.forkChild(Effect.flip(discoverIdentity("access-token")));
      yield* TestClock.adjust("1 minute");
      const error = yield* Fiber.join(requestFiber);
      assert.include(error.message, "timed out");
      assert.isAbove(signals.length, 0);
      assert.isTrue(signals.every((signal) => signal.aborted));
    }),
  );
});
