import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { ConnectionVerifier, layer } from "./connection-verify";
import type { Credential } from "./credential-store";
import { layer as githubClientLayer } from "./github/client";

const apiKey = (token: string): Credential => ({
  source: "stored-key",
  token: Redacted.make(token),
  identity: null,
});

class FetchedUrls extends Context.Service<FetchedUrls, Ref.Ref<ReadonlyArray<string>>>()(
  "@cogwork/engine/connection-verify.test/FetchedUrls",
) {
  static readonly layer = Layer.effect(FetchedUrls, Ref.make<ReadonlyArray<string>>([]));
}

const urlOf = (input: RequestInfo | URL) =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

const respondingWith = (status: number, body = "{}") =>
  layer.pipe(
    Layer.provide(githubClientLayer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(
      Layer.effect(
        FetchHttpClient.Fetch,
        Effect.gen(function* () {
          const seen = yield* FetchedUrls;
          return (input: RequestInfo | URL) =>
            Ref.update(seen, (current) => [...current, urlOf(input)]).pipe(
              Effect.map(() => new Response(body, { status })),
              Effect.runPromise,
            );
        }),
      ),
    ),
    Layer.provideMerge(FetchedUrls.layer),
  );

describe("ConnectionVerifier", () => {
  it.effect("asks GitHub whether the token authenticates at all", () =>
    Effect.gen(function* () {
      const verifier = yield* ConnectionVerifier;
      const account = yield* verifier.verify("github", apiKey("ghp_real"));

      assert.strictEqual(account, "octocat");
      assert.deepStrictEqual(yield* Ref.get(yield* FetchedUrls), ["https://api.github.com/user"]);
    }).pipe(Effect.provide(respondingWith(200, '{"login":"octocat"}'))),
  );

  // The bug this covers: GITHUB_TOKEN=Hello resolves to a non-empty string, so every local check
  // passed and the card went green. Only GitHub can answer this, and it answers 401.
  it.effect("reports a rejected token as an auth failure", () =>
    Effect.gen(function* () {
      const verifier = yield* ConnectionVerifier;
      const error = yield* Effect.flip(verifier.verify("github", apiKey("Hello")));

      assert.strictEqual(error.reason, "auth");
      assert.include(error.message, "401");
    }).pipe(Effect.provide(respondingWith(401))),
  );

  // A dead network must not read as a bad credential: telling someone to re-issue a working token
  // because their wifi dropped is worse than not checking at all.
  it.effect("separates an unreachable GitHub from a rejected token", () =>
    Effect.gen(function* () {
      const verifier = yield* ConnectionVerifier;
      const error = yield* Effect.flip(verifier.verify("github", apiKey("ghp_real")));

      assert.strictEqual(error.reason, "unavailable");
    }).pipe(Effect.provide(respondingWith(503, ""))),
  );

  it.effect("asks Granola to accept the credential", () =>
    Effect.gen(function* () {
      const verifier = yield* ConnectionVerifier;
      const account = yield* verifier.verify("granola", apiKey("grn_real"));

      assert.strictEqual(account, null);
      assert.deepStrictEqual(yield* Ref.get(yield* FetchedUrls), ["https://mcp.granola.ai/mcp"]);
    }).pipe(Effect.provide(respondingWith(200))),
  );

  it.effect("reports a revoked Granola credential as an auth failure", () =>
    Effect.gen(function* () {
      const verifier = yield* ConnectionVerifier;
      const error = yield* Effect.flip(verifier.verify("granola", apiKey("grn_revoked")));

      assert.strictEqual(error.reason, "auth");
      assert.include(error.message, "401");
    }).pipe(Effect.provide(respondingWith(401))),
  );
});
