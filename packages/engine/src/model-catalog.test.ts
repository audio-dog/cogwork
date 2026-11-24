import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Ref from "effect/Ref";
import { TestClock } from "effect/testing";
import { vi } from "vitest";

import { type CatalogApi, CatalogError, type CatalogSource, httpSource, makeService } from "./model-catalog";

const api: CatalogApi = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    models: {
      "claude-opus-4": { id: "claude-opus-4", name: "Claude Opus 4" },
      "claude-haiku": { id: "claude-haiku" },
    },
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    models: { "gpt-5": { id: "gpt-5", name: "GPT-5" } },
  },
};

const harness = Effect.fn("harness")(function* (catalog: CatalogApi) {
  const fetches = yield* Ref.make(0);
  const failing = yield* Ref.make(false);
  const source: CatalogSource = {
    fetch: Effect.gen(function* () {
      yield* Ref.update(fetches, (count) => count + 1);
      if (yield* Ref.get(failing)) return yield* new CatalogError({ message: "boom" });
      return catalog;
    }),
  };
  return { source, fetches: Ref.get(fetches), fail: Ref.set(failing, true) };
});

describe("ModelCatalog", () => {
  it.effect("lists models for the requested providers, skipping unconfigured ones", () =>
    Effect.gen(function* () {
      const { source } = yield* harness(api);
      const catalog = yield* makeService(source);
      const models = yield* catalog.models(["anthropic", "openai", "google"]);
      assert.deepStrictEqual(
        models.map((model) => [model.provider, model.id, model.name]),
        [
          ["anthropic", "claude-haiku", "claude-haiku"],
          ["anthropic", "claude-opus-4", "Claude Opus 4"],
          ["openai", "gpt-5", "GPT-5"],
        ],
      );
    }),
  );

  it.effect("fetches once and serves the cache within the TTL", () =>
    Effect.gen(function* () {
      const { source, fetches } = yield* harness(api);
      const catalog = yield* makeService(source);
      yield* catalog.models(["anthropic"]);
      yield* catalog.models(["openai"]);
      assert.strictEqual(yield* fetches, 1);
    }),
  );

  it.effect("starts the TTL when the fetch completes", () =>
    Effect.gen(function* () {
      const fetches = yield* Ref.make(0);
      const source: CatalogSource = {
        fetch: Ref.getAndUpdate(fetches, (count) => count + 1).pipe(
          Effect.flatMap((attempt) =>
            attempt === 0 ? Effect.sleep("2 seconds").pipe(Effect.map(() => api)) : Effect.succeed(api),
          ),
        ),
      };
      const catalog = yield* makeService(source, 1_000);
      const firstRead = yield* catalog.models(["anthropic"]).pipe(Effect.forkChild);
      yield* TestClock.adjust("2 seconds");
      yield* Fiber.join(firstRead);
      yield* catalog.models(["openai"]);
      assert.strictEqual(yield* Ref.get(fetches), 1);
    }),
  );

  it.effect("single-flights concurrent cold reads", () =>
    Effect.gen(function* () {
      const fetches = yield* Ref.make(0);
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const source: CatalogSource = {
        fetch: Ref.update(fetches, (count) => count + 1).pipe(
          Effect.andThen(Deferred.succeed(started, undefined)),
          Effect.andThen(Deferred.await(release)),
          Effect.map(() => api),
        ),
      };
      const catalog = yield* makeService(source);
      const reads = yield* Effect.all(
        Array.from({ length: 3 }, () => catalog.models(["anthropic"])),
        { concurrency: "unbounded" },
      ).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(reads);
      assert.strictEqual(yield* Ref.get(fetches), 1);
    }),
  );

  it.effect("serves the stale catalog when a refresh fails after a good load", () =>
    Effect.gen(function* () {
      const { source, fail, fetches } = yield* harness(api);
      const catalog = yield* makeService(source, 0);
      yield* catalog.models(["anthropic"]);
      yield* fail;
      const models = yield* catalog.models(["openai"]);
      assert.deepStrictEqual(
        models.map((model) => model.id),
        ["gpt-5"],
      );
      assert.strictEqual(yield* fetches, 2);
    }),
  );

  it.effect("fails when the first fetch fails and nothing is cached", () =>
    Effect.gen(function* () {
      const { source, fail } = yield* harness(api);
      yield* fail;
      const catalog = yield* makeService(source, 0);
      const error = yield* Effect.flip(catalog.models(["anthropic"]));
      assert.strictEqual(error.message, "boom");
    }),
  );
});

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const withFetch =
  (fetch: typeof globalThis.fetch) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provide(FetchHttpClient.layer), Effect.provideService(FetchHttpClient.Fetch, fetch));

describe("ModelCatalog httpSource", () => {
  it.effect("serves the stale catalog when a refresh times out", () => {
    const onAbort = vi.fn<() => void>();
    const fetchStub = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(api))
      .mockImplementation((_input, init) => {
        const response = Promise.withResolvers<Response>();
        init?.signal?.addEventListener(
          "abort",
          () => {
            onAbort();
            response.reject(new DOMException("The request was aborted", "AbortError"));
          },
          { once: true },
        );
        return response.promise;
      });
    return Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const catalog = yield* makeService(httpSource(client), 0);
      yield* catalog.models(["anthropic"]);
      const refresh = yield* catalog.models(["openai"]).pipe(Effect.timeout("31 seconds"), Effect.forkChild);
      yield* TestClock.adjust("31 seconds");
      const models = yield* Fiber.join(refresh);
      assert.deepStrictEqual(
        models.map((model) => model.id),
        ["gpt-5"],
      );
      assert.strictEqual(fetchStub.mock.calls.length, 2);
      assert.strictEqual(onAbort.mock.calls.length, 1);
    }).pipe(withFetch(fetchStub));
  });

  it.effect("decodes a 200 api.json into the catalog shape", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const source = httpSource(client, "https://models.dev/api.json");
      const catalog = yield* makeService(source);
      const models = yield* catalog.models(["anthropic"]);
      assert.deepStrictEqual(
        models.map((model) => model.id),
        ["claude-haiku", "claude-opus-4"],
      );
    }).pipe(withFetch(() => Promise.resolve(jsonResponse(api)))),
  );

  it.effect("reports a CatalogError on a non-200 response", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const source = httpSource(client, "https://models.dev/api.json");
      const error = yield* Effect.flip(source.fetch);
      assert.include(error.message, "HTTP 503");
    }).pipe(withFetch(() => Promise.resolve(jsonResponse({}, 503)))),
  );

  it.effect("reports a CatalogError when the body is the wrong shape", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const source = httpSource(client, "https://models.dev/api.json");
      const error = yield* Effect.flip(source.fetch);
      assert.include(error.message, "unexpected shape");
    }).pipe(withFetch(() => Promise.resolve(jsonResponse({ anthropic: { id: "anthropic" } })))),
  );
});
