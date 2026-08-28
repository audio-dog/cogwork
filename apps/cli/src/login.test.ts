import { CredentialStore } from "@cogwork/engine";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { afterEach, vi } from "vitest";
import { makeFileStore } from "./credentials";
import { BrowserOpener, type LinearLoginConfig, loginKey, loginLinear } from "./login";

const redirectPort = 39_642;

const config: LinearLoginConfig = { clientId: "client-1", redirectPort };

const tokenBody = {
  access_token: "linear-access-token",
  token_type: "Bearer",
  expires_in: 86_399,
  scope: "read write",
  refresh_token: "linear-refresh-token",
};

const realFetch = globalThis.fetch.bind(globalThis);

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

const graphqlBody = (init: RequestInit | undefined) => {
  const body = init?.body;
  if (typeof body !== "string") return "";
  const parsed: { readonly query?: string } = JSON.parse(body);
  return parsed.query ?? "";
};

// Routes the two Linear endpoints the flow touches to canned responses. The loopback callback is
// driven separately by the fake browser opener, which hits the real server directly.
const routedFetch: typeof globalThis.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.includes("/oauth/token")) return Promise.resolve(jsonResponse(tokenBody));
  const document = graphqlBody(init);
  const data = document.includes("query viewer")
    ? { data: { viewer: { id: "bot-user" } } }
    : { data: { organization: { id: "org-uuid", name: "Acme", urlKey: "acme", projectStatuses: [] } } };
  return Promise.resolve(jsonResponse(data));
};

const fakeBrowser = Layer.succeed(BrowserOpener, {
  open: (url) =>
    Effect.promise(() => {
      const authorize = new URL(url);
      const state = authorize.searchParams.get("state") ?? "";
      const redirectUri = authorize.searchParams.get("redirect_uri") ?? "";
      const callback = `${redirectUri}?code=canned-code&state=${encodeURIComponent(state)}`;
      return realFetch(callback).then(() => undefined);
    }),
});

describe("login linear", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.live("catches the loopback redirect, exchanges the code, and stores the discovered identity", () =>
    Effect.gen(function* () {
      vi.stubGlobal("fetch", vi.fn(routedFetch));
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-login-" });
      const filePath = path.join(dir, "credentials.json");

      const result = yield* loginLinear(config).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.effect(
              CredentialStore.CredentialStore,
              Effect.gen(function* () {
                const stored = yield* makeFileStore(filePath);
                return CredentialStore.make({ stored });
              }),
            ),
            fakeBrowser,
            FetchHttpClient.layer,
          ),
        ),
        Effect.provideService(FetchHttpClient.Fetch, routedFetch),
      );

      assert.deepStrictEqual(result, { organization: "acme", actorUserId: "bot-user" });

      const store = yield* makeFileStore(filePath);
      const stored = yield* store.load;
      assert.strictEqual(stored.length, 1);
      assert.strictEqual(stored[0]?.organization, "acme");
      assert.strictEqual(stored[0]?.actorUserId, "bot-user");
      assert.strictEqual(stored[0] && Redacted.value(stored[0].token.accessToken), "linear-access-token");
      assert.deepStrictEqual(stored[0]?.token.scopes, ["read", "write"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("does not store a login for a different established organization", () =>
    Effect.gen(function* () {
      vi.stubGlobal("fetch", vi.fn(routedFetch));
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-login-" });
      const filePath = path.join(dir, "credentials.json");
      const switchedConfig = { ...config, expectedOrganization: "other" };

      const error = yield* Effect.flip(
        loginLinear(switchedConfig).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.effect(
                CredentialStore.CredentialStore,
                Effect.gen(function* () {
                  const stored = yield* makeFileStore(filePath);
                  return CredentialStore.make({ stored });
                }),
              ),
              fakeBrowser,
              FetchHttpClient.layer,
            ),
          ),
          Effect.provideService(FetchHttpClient.Fetch, routedFetch),
        ),
      );

      assert.include(error.message, "other");
      assert.deepStrictEqual(yield* (yield* makeFileStore(filePath)).load, []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

const onDiskStore = <A, E>(
  use: (
    filePath: string,
  ) => Effect.Effect<A, E, CredentialStore.CredentialStore | FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-login-key-" });
    const filePath = path.join(dir, "credentials.json");
    return yield* use(filePath).pipe(
      Effect.provide(
        Layer.effect(
          CredentialStore.CredentialStore,
          Effect.map(makeFileStore(filePath), (stored) => CredentialStore.make({ stored })),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("login key", () => {
  it.effect("stores a pasted key and resolves it back through the seam", () =>
    onDiskStore((filePath) =>
      Effect.gen(function* () {
        const result = yield* loginKey({ provider: "anthropic", key: "  sk-ant-123  " });
        assert.deepStrictEqual(result, { provider: "anthropic", displayName: "Anthropic" });
        const store = yield* CredentialStore.CredentialStore;
        const credential = yield* store.providerKey({
          provider: "anthropic",
          envVars: ["ANTHROPIC_API_KEY"],
        });
        assert.strictEqual(credential.source, "stored-key");
        assert.strictEqual(Redacted.value(credential.key), "sk-ant-123");
        return filePath;
      }),
    ),
  );

  it.effect("rejects an unknown provider", () =>
    onDiskStore(() =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(loginKey({ provider: "nope", key: "sk-x" }));
        assert.include(error.message, `unknown provider "nope"`);
      }),
    ),
  );

  it.effect("rejects a blank key", () =>
    onDiskStore(() =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(loginKey({ provider: "openai", key: "   " }));
        assert.include(error.message, "no api key provided");
      }),
    ),
  );
});
