import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { vi } from "vitest";
import { layer as clientLayer, GitHubClient, type GitHubRepoRef } from "./client";

const repo: GitHubRepoRef = {
  owner: "colonylabs",
  name: "cogwork",
  tokenEnv: "GITHUB_TOKEN",
};

const jsonResponse = (body: unknown = {}, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const configLayer = ConfigProvider.layer(ConfigProvider.fromEnv({ env: { GITHUB_TOKEN: "test-token" } }));

const withClient =
  (fetch: typeof globalThis.fetch) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provide(Layer.merge(clientLayer.pipe(Layer.provide(FetchHttpClient.layer)), configLayer)),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    );

const withHttpClient =
  (client: HttpClient.HttpClient) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provide(
      effect,
      Layer.merge(clientLayer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client))), configLayer),
    );

describe("GitHub client", () => {
  it.effect("retries a comment write after a hanging attempt reaches its deadline", () => {
    const onAbort = vi.fn();
    const fetch = vi.fn<typeof globalThis.fetch>((_input, init) => {
      if (fetch.mock.calls.length > 1) return Promise.resolve(jsonResponse());
      init?.signal?.addEventListener("abort", onAbort);
      return Promise.withResolvers<Response>().promise;
    });

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      const request = yield* Effect.forkChild(client.createComment(repo, 287, "claim"));
      yield* TestClock.adjust("1 minute");
      assert.strictEqual(fetch.mock.calls.length, 2);
      yield* Fiber.join(request);
      assert.strictEqual(onAbort.mock.calls.length, 1);
    }).pipe(withClient(fetch));
  });

  it.effect("retries a transient label removal", () => {
    const status = vi.fn().mockReturnValueOnce(503).mockReturnValue(200);
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(jsonResponse({}, status())));

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      const request = yield* Effect.forkChild(client.removeLabel(repo, 287, "cogwork:claimed"));
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(request);
      assert.strictEqual(fetch.mock.calls.length, 2);
    }).pipe(withClient(fetch));
  });

  it.effect("bounds project priority pagination as one operation", () => {
    const page = {
      data: {
        repositoryOwner: {
          projectV2: {
            items: {
              pageInfo: { hasNextPage: true, endCursor: "same-cursor" },
              nodes: [],
            },
          },
        },
      },
    };
    const respond = vi.fn((request: HttpClientRequest.HttpClientRequest) =>
      HttpClientResponse.fromWeb(request, jsonResponse(page)),
    );
    const httpClient = HttpClient.make((request) =>
      Effect.sleep("20 seconds").pipe(Effect.map(() => respond(request))),
    );

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      const request = yield* Effect.forkChild(Effect.flip(client.projectPriorities(repo, { project: 1 })));
      yield* TestClock.adjust("6 minutes");
      const error = yield* Fiber.join(request);
      assert.strictEqual(error.reason, "unavailable");
      assert.include(error.message, "pagination timed out");
      assert.isAbove(respond.mock.calls.length, 1);
    }).pipe(withHttpClient(httpClient));
  });

  it.effect("bounds pull closing-reference pagination as one operation", () => {
    const page = {
      data: {
        repository: {
          pullRequests: {
            pageInfo: { hasNextPage: true, endCursor: "same-cursor" },
            nodes: [],
          },
        },
      },
    };
    const respond = vi.fn((request: HttpClientRequest.HttpClientRequest) =>
      HttpClientResponse.fromWeb(request, jsonResponse(request.url.endsWith("/graphql") ? page : [])),
    );
    const httpClient = HttpClient.make((request) =>
      Effect.sleep("20 seconds").pipe(Effect.map(() => respond(request))),
    );

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      const request = yield* Effect.forkChild(Effect.flip(client.listPulls(repo)));
      yield* TestClock.adjust("6 minutes");
      const error = yield* Fiber.join(request);
      assert.strictEqual(error.reason, "unavailable");
      assert.include(error.message, "pagination timed out");
      assert.isAbove(respond.mock.calls.length, 1);
    }).pipe(withHttpClient(httpClient));
  });

  it.effect("does not retry a rejected write", () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(jsonResponse({}, 401)));

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      const error = yield* Effect.flip(client.createComment(repo, 287, "claim"));
      assert.strictEqual(error.reason, "auth");
      assert.strictEqual(fetch.mock.calls.length, 1);
    }).pipe(withClient(fetch));
  });
});
