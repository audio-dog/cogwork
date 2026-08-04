import { CredentialStore } from "@clanker-forge/engine";
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
import { BrowserOpener, type LinearLoginConfig, loginLinear } from "./login";

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
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "clanker-forge-login-" });
      const filePath = path.join(dir, "credentials.json");

      const result = yield* loginLinear(config).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.effect(
              CredentialStore.CredentialStore,
              Effect.map(makeFileStore(filePath), CredentialStore.make),
            ),
            fakeBrowser,
            FetchHttpClient.layer,
          ),
        ),
        Effect.provideService(FetchHttpClient.Fetch, routedFetch),
      );

      assert.deepStrictEqual(result, { organization: "acme", botUserId: "bot-user" });

      const store = yield* makeFileStore(filePath);
      const stored = yield* store.load;
      assert.strictEqual(stored.length, 1);
      assert.strictEqual(stored[0]?.organization, "acme");
      assert.strictEqual(stored[0]?.botUserId, "bot-user");
      assert.strictEqual(stored[0] && Redacted.value(stored[0].token.accessToken), "linear-access-token");
      assert.deepStrictEqual(stored[0]?.token.scopes, ["read", "write"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
