// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as Http from "node:http";
import { CredentialStore } from "@cogwork/engine";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type * as HttpServer from "effect/unstable/http/HttpServer";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { afterEach, vi } from "vitest";
import { makeFileStore } from "./credentials";
import { BrowserOpener, browserOpenerLayer, type LinearLoginConfig, loginKey, loginLinear } from "./login";

const interruptionGate = Latch.makeUnsafe();

const loginConfigFromServer = (server: HttpServer.HttpServer["Service"]): LinearLoginConfig => {
  const { address } = server;
  if (address._tag === "UnixAddress") assert.fail("Expected an ephemeral TCP address");
  return { clientId: "client-1", redirectPort: address.port };
};

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

const requestUrl = (input: string | URL | Request) => {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
};

// Routes the two Linear endpoints the flow touches to canned responses. The loopback callback is
// driven separately by the fake browser opener, which hits the real server directly.
const routedFetch: typeof globalThis.fetch = (input, init) => {
  const url = requestUrl(input);
  if (url.includes("/oauth/token")) return Promise.resolve(jsonResponse(tokenBody));
  const document = graphqlBody(init);
  const data = document.includes("query viewer")
    ? { data: { viewer: { id: "bot-user" } } }
    : { data: { organization: { id: "org-uuid", name: "Acme", urlKey: "acme", projectStatuses: [] } } };
  return Promise.resolve(jsonResponse(data));
};

const completeCallback = (url: string) =>
  Effect.promise(() => {
    const authorize = new URL(url);
    const state = authorize.searchParams.get("state") ?? "";
    const redirectUri = authorize.searchParams.get("redirect_uri") ?? "";
    const callback = `${redirectUri}?code=canned-code&state=${encodeURIComponent(state)}`;
    return realFetch(callback).then(() => undefined);
  });

const fakeBrowser = Layer.succeed(BrowserOpener, {
  open: completeCallback,
});

class LoginCredentialFile extends Context.Service<LoginCredentialFile, string>()(
  "@cogwork/cli/login.test/LoginCredentialFile",
) {}

const withLoginTest = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  openerLayer: Layer.Layer<BrowserOpener> = fakeBrowser,
) =>
  effect.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.effect(
          CredentialStore.CredentialStore,
          Effect.gen(function* () {
            const filePath = yield* LoginCredentialFile;
            const stored = yield* makeFileStore(filePath);
            return CredentialStore.make({ stored });
          }),
        ),
        openerLayer,
        FetchHttpClient.layer,
      ).pipe(
        Layer.provideMerge(
          Layer.effect(
            LoginCredentialFile,
            Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem;
              const path = yield* Path.Path;
              const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-login-" });
              return path.join(dir, "credentials.json");
            }),
          ),
        ),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.provideService(FetchHttpClient.Fetch, routedFetch),
  );

describe("login linear", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.live("catches the loopback redirect, exchanges the code, and stores the discovered identity", () =>
    Effect.gen(function* () {
      vi.stubGlobal("fetch", vi.fn(routedFetch));
      const config: LinearLoginConfig = yield* NodeHttpServer.make(Http.createServer, { port: 0 }).pipe(
        Effect.map(loginConfigFromServer),
        Effect.scoped,
      );
      const filePath = yield* LoginCredentialFile;
      const result = yield* loginLinear(config);

      assert.deepStrictEqual(result, { organization: "acme", actorUserId: "bot-user" });

      const store = yield* makeFileStore(filePath);
      const stored = yield* store.load;
      assert.strictEqual(stored.length, 1);
      assert.strictEqual(stored[0]?.organization, "acme");
      assert.strictEqual(stored[0]?.actorUserId, "bot-user");
      assert.strictEqual(stored[0] && Redacted.value(stored[0].token.accessToken), "linear-access-token");
      assert.deepStrictEqual(stored[0]?.token.scopes, ["read", "write"]);
    }).pipe(withLoginTest),
  );

  it.live("does not store a login for a different established organization", () =>
    Effect.gen(function* () {
      vi.stubGlobal("fetch", vi.fn(routedFetch));
      const config: LinearLoginConfig = yield* NodeHttpServer.make(Http.createServer, { port: 0 }).pipe(
        Effect.map(loginConfigFromServer),
        Effect.scoped,
      );
      const filePath = yield* LoginCredentialFile;
      const switchedConfig = { ...config, expectedOrganization: "other" };

      const error = yield* Effect.flip(loginLinear(switchedConfig));

      assert.include(error.message, "other");
      assert.deepStrictEqual(yield* (yield* makeFileStore(filePath)).load, []);
    }).pipe(withLoginTest),
  );

  it.live("completes when the callback arrives before the browser opener returns", () =>
    Effect.gen(function* () {
      vi.stubGlobal("fetch", vi.fn(routedFetch));
      const config: LinearLoginConfig = yield* NodeHttpServer.make(Http.createServer, { port: 0 }).pipe(
        Effect.map(loginConfigFromServer),
        Effect.scoped,
      );
      const hangingBrowser = Layer.succeed(BrowserOpener, {
        open: (url: string) => completeCallback(url).pipe(Effect.andThen(interruptionGate.await)),
      });

      const result = yield* loginLinear(config).pipe((effect) => withLoginTest(effect, hangingBrowser));

      assert.deepStrictEqual(result, { organization: "acme", actorUserId: "bot-user" });
    }),
  );

  it.effect("times out waiting for the callback and releases the loopback port", () =>
    Effect.gen(function* () {
      vi.stubGlobal("fetch", vi.fn(routedFetch));
      const config: LinearLoginConfig = yield* NodeHttpServer.make(Http.createServer, { port: 0 }).pipe(
        Effect.map(loginConfigFromServer),
        Effect.scoped,
      );
      const opened = yield* Deferred.make<void>();
      const silentBrowser = Layer.succeed(BrowserOpener, { open: () => Deferred.succeed(opened, undefined) });
      const first = yield* Effect.forkChild(
        Effect.flip(loginLinear(config)).pipe((effect) => withLoginTest(effect, silentBrowser)),
      );

      yield* Deferred.await(opened);
      yield* TestClock.adjust("5 minutes");
      const error = yield* Fiber.join(first);

      assert.include(error.message, "timed out");
      assert.include(error.message, "retry");
      assert.deepStrictEqual(yield* loginLinear(config).pipe(withLoginTest), {
        organization: "acme",
        actorUserId: "bot-user",
      });
    }),
  );
});

describe("browser opener", () => {
  it.effect("rejects a non-HTTPS authorization URL before spawning", () =>
    Effect.gen(function* () {
      const opener = yield* BrowserOpener;
      const error = yield* Effect.flip(opener.open("http://example.com/authorize"));

      assert.include(error.message, "non-HTTPS URL");
    }).pipe(
      Effect.provide(
        browserOpenerLayer.pipe(
          Layer.provide(
            Layer.succeed(
              ChildProcessSpawner.ChildProcessSpawner,
              ChildProcessSpawner.make(() =>
                Effect.succeed(
                  ChildProcessSpawner.makeHandle({
                    pid: ChildProcessSpawner.ProcessId(1),
                    stdin: Sink.drain,
                    stdout: Stream.empty,
                    stderr: Stream.empty,
                    all: Stream.empty,
                    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
                    isRunning: Effect.succeed(false),
                    kill: () => Effect.void,
                    getInputFd: () => Sink.drain,
                    getOutputFd: () => Stream.empty,
                    unref: Effect.succeed(Effect.void),
                  }),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );

  it.effect("times out a hanging browser subprocess with retry guidance", () =>
    Effect.gen(function* () {
      const opener = yield* BrowserOpener;
      const fiber = yield* Effect.forkChild(Effect.flip(opener.open("https://linear.app/oauth/authorize")));

      yield* TestClock.adjust("30 seconds");
      const error = yield* Fiber.join(fiber);

      assert.strictEqual(error._tag, "LinearOAuthError");
      assert.strictEqual(error.message, "Opening the browser timed out after 30 seconds; retry the login.");
    }).pipe(
      Effect.provide(
        browserOpenerLayer.pipe(
          Layer.provide(
            Layer.succeed(
              ChildProcessSpawner.ChildProcessSpawner,
              ChildProcessSpawner.make(() =>
                Effect.succeed(
                  ChildProcessSpawner.makeHandle({
                    pid: ChildProcessSpawner.ProcessId(1),
                    stdin: Sink.drain,
                    stdout: Stream.empty,
                    stderr: Stream.empty,
                    all: Stream.empty,
                    exitCode: Effect.map(interruptionGate.await, () => ChildProcessSpawner.ExitCode(0)),
                    isRunning: Effect.succeed(true),
                    kill: () => Effect.void,
                    getInputFd: () => Sink.drain,
                    getOutputFd: () => Stream.empty,
                    unref: Effect.succeed(Effect.void),
                  }),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
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
