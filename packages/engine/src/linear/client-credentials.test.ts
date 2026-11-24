import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { TestClock } from "effect/testing";
import { vi } from "vitest";

import type { CredentialAccount } from "../credential-store";
import { make } from "./client-credentials";

const secretEnv = "LINEAR_CLIENT_SECRET";

const account: CredentialAccount = {
  key: "AUD",
  issueTracker: "linear",
  organization: null,
  tokenEnv: "LINEAR_API_KEY",
  clientCredentials: { clientId: "client-1", secretEnv },
  oauthClientId: null,
};

const browserOnly: CredentialAccount = { ...account, clientCredentials: null };

const lifetimeSeconds = 2_592_000;

const tokenBody = (accessToken: string) => ({
  access_token: accessToken,
  token_type: "Bearer",
  expires_in: lifetimeSeconds,
  scope: "read,write",
});

interface StubResponse {
  readonly status?: number;
  readonly body: unknown;
}

interface Call {
  readonly url: string;
  readonly params: Record<string, string>;
}

const sentBody = (body: BodyInit | null | undefined) => {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  return "";
};

const stubTokenEndpoint = (responses: ReadonlyArray<StubResponse>) => {
  const calls: Array<Call> = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    const { status = 200, body } = responses[Math.min(calls.length, responses.length - 1)] ?? { body: {} };
    const encoded = sentBody(init?.body);
    calls.push({ url: String(input), params: Object.fromEntries(new URLSearchParams(encoded)) });
    return Promise.resolve(
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
    );
  };
  return { fetch, calls: calls as ReadonlyArray<Call> };
};

const granting = (
  responses: ReadonlyArray<StubResponse>,
  env: Record<string, string> = { [secretEnv]: "s3cret" },
) => {
  const endpoint = stubTokenEndpoint(responses);
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(FetchHttpClient.Fetch, endpoint.fetch),
      Effect.provide(
        Layer.mergeAll(FetchHttpClient.layer, ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
      ),
    );
  return { calls: endpoint.calls, run };
};

const ok = (accessToken: string) => ({ body: tokenBody(accessToken) });

describe("linear client credentials", () => {
  it.effect("mints an app token from the client id and the secret in the env var", () => {
    const { calls, run } = granting([ok("app-token")]);
    return run(
      Effect.gen(function* () {
        const grant = yield* make();
        const token = yield* grant.token(account);
        assert.strictEqual(token && Redacted.value(token), "app-token");
        assert.strictEqual(calls[0]?.url, "https://api.linear.app/oauth/token");
        assert.deepStrictEqual(calls[0]?.params, {
          grant_type: "client_credentials",
          client_id: "client-1",
          client_secret: "s3cret",
          scope: "read,write,app:assignable,app:mentionable",
        });
      }),
    );
  });

  it.effect("reuses the minted token instead of asking Linear again", () => {
    const { calls, run } = granting([ok("app-token")]);
    return run(
      Effect.gen(function* () {
        const grant = yield* make();
        yield* grant.token(account);
        yield* grant.token(account);
        assert.strictEqual(calls.length, 1);
      }),
    );
  });

  it.effect("mints a replacement once the token it holds is forgotten", () => {
    const { calls, run } = granting([ok("first-token"), ok("second-token")]);
    return run(
      Effect.gen(function* () {
        const grant = yield* make();
        yield* grant.token(account);
        yield* grant.forget(account);
        const token = yield* grant.token(account);
        assert.strictEqual(token && Redacted.value(token), "second-token");
        assert.strictEqual(calls.length, 2);
      }),
    );
  });

  it.effect("mints a replacement once the token's lifetime has run out", () => {
    const { calls, run } = granting([ok("first-token"), ok("second-token")]);
    return run(
      Effect.gen(function* () {
        const grant = yield* make();
        yield* grant.token(account);
        yield* TestClock.adjust(`${lifetimeSeconds - 3_600} seconds`);
        yield* grant.token(account);
        assert.strictEqual(calls.length, 1);
        yield* TestClock.adjust("2 hours");
        const token = yield* grant.token(account);
        assert.strictEqual(token && Redacted.value(token), "second-token");
      }),
    );
  });

  it.effect("stays out of the way of an account that never asked for client credentials", () => {
    const { calls, run } = granting([ok("app-token")]);
    return run(
      Effect.gen(function* () {
        const grant = yield* make();
        assert.strictEqual(yield* grant.token(browserOnly), null);
        yield* grant.forget(browserOnly);
        assert.strictEqual(calls.length, 0);
      }),
    );
  });

  it.effect("names the env var it needs when the secret is missing", () => {
    const { calls, run } = granting([ok("app-token")], {});
    return run(
      Effect.gen(function* () {
        const grant = yield* make();
        const error = yield* Effect.flip(grant.token(account));
        assert.strictEqual(error.account, "AUD");
        assert.include(error.message, secretEnv);
        assert.strictEqual(calls.length, 0);
      }),
    );
  });

  it.effect("treats a whitespace-only secret as missing", () => {
    const { run } = granting([ok("app-token")], { [secretEnv]: "   " });
    return run(
      Effect.gen(function* () {
        const grant = yield* make();
        const error = yield* Effect.flip(grant.token(account));
        assert.include(error.message, secretEnv);
      }),
    );
  });

  it.effect("reports a rejected grant without echoing the secret", () => {
    const { run } = granting([
      { status: 400, body: { error: "Error", error_description: "client_secret s3cret is invalid" } },
    ]);
    return run(
      Effect.gen(function* () {
        const grant = yield* make();
        const error = yield* Effect.flip(grant.token(account));
        assert.include(error.message, "rejected");
        assert.notInclude(error.message, "s3cret");
      }),
    );
  });

  it.effect("fails a hanging mint at the token endpoint deadline", () => {
    const onAbort = vi.fn<() => void>();
    const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(FetchHttpClient.Fetch, ((_input, init) => {
          init?.signal?.addEventListener("abort", onAbort);
          return Promise.withResolvers<Response>().promise;
        }) satisfies typeof globalThis.fetch),
        Effect.provide(
          Layer.mergeAll(
            FetchHttpClient.layer,
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: { [secretEnv]: "s3cret" } })),
          ),
        ),
      );
    return run(
      Effect.gen(function* () {
        const grant = yield* make();
        const requestFiber = yield* Effect.forkChild(Effect.flip(grant.token(account)));
        yield* TestClock.adjust("1 minute");
        const error = yield* Fiber.join(requestFiber);
        assert.strictEqual(error.account, "AUD");
        assert.include(error.message, "timed out");
        assert.strictEqual(onAbort.mock.calls.length, 1);
      }),
    );
  });

  it.effect("reports a token response it cannot read", () => {
    const { run } = granting([{ body: { access_token: "" } }]);
    return run(
      Effect.gen(function* () {
        const grant = yield* make();
        const error = yield* Effect.flip(grant.token(account));
        assert.include(error.message, "unreadable");
      }),
    );
  });

  it.effect("retries a rejected grant on the next call rather than caching the failure", () => {
    const { calls, run } = granting([{ status: 500, body: {} }, ok("app-token")]);
    return run(
      Effect.gen(function* () {
        const grant = yield* make();
        yield* Effect.flip(grant.token(account));
        const token = yield* grant.token(account);
        assert.strictEqual(token && Redacted.value(token), "app-token");
        assert.strictEqual(calls.length, 2);
      }),
    );
  });
});
