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
import type { IssueTrackerError } from "../issue-tracker";
import { layer as clientLayer, GitHubClient, type GitHubClientService, type GitHubRepoRef } from "./client";

const repo: GitHubRepoRef = {
  owner: "colonylabs",
  name: "cogwork",
  tokenEnv: "GITHUB_TOKEN",
};

const jsonResponse = (body: unknown = {}, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const hangingResponse = (prefix: string, status = 200) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start: (controller) => controller.enqueue(new TextEncoder().encode(prefix)),
    }),
    { status },
  );

const configLayer = ConfigProvider.layer(ConfigProvider.fromEnv({ env: { GITHUB_TOKEN: "test-token" } }));

const withFetchClient =
  (fetch: typeof globalThis.fetch) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provide(
      effect,
      Layer.merge(
        clientLayer.pipe(
          Layer.provide(
            FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
          ),
        ),
        configLayer,
      ),
    );

const withHttpClient =
  (client: HttpClient.HttpClient) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provide(
      effect,
      Layer.merge(clientLayer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client))), configLayer),
    );

const delayedJsonClient = (bodyOf: (request: HttpClientRequest.HttpClientRequest) => unknown) => {
  const requests = vi.fn((request: HttpClientRequest.HttpClientRequest) =>
    HttpClientResponse.fromWeb(request, jsonResponse(bodyOf(request))),
  );
  const client = HttpClient.make((request) =>
    Effect.sleep("20 seconds").pipe(Effect.map(() => requests(request))),
  );
  return { client, requests };
};

const afterPaginationDeadline = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const operation = yield* Effect.forkChild(effect);
    yield* TestClock.adjust("6 minutes");
    return yield* Fiber.join(operation);
  });

const rejectedWrite = (status: number, reason: "auth" | "unavailable") => {
  const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(jsonResponse({}, status)));
  return Effect.gen(function* () {
    const client = yield* GitHubClient;
    const error = yield* Effect.flip(client.createComment(repo, 287, "claim"));
    assert.strictEqual(error.reason, reason);
    assert.strictEqual(fetch.mock.calls.length, 1);
  }).pipe(withFetchClient(fetch));
};

const transientWrite = (
  firstStatus: number,
  write: (client: GitHubClientService) => Effect.Effect<void, IssueTrackerError>,
) => {
  const status = vi.fn().mockReturnValueOnce(firstStatus).mockReturnValue(201);
  const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(jsonResponse({}, status())));
  return Effect.gen(function* () {
    const client = yield* GitHubClient;
    const operation = yield* Effect.forkChild(write(client));
    yield* TestClock.adjust("1 second");
    yield* Fiber.join(operation);
    assert.strictEqual(fetch.mock.calls.length, 2);
  }).pipe(withFetchClient(fetch));
};

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
      const operation = yield* Effect.forkChild(client.createComment(repo, 287, "claim"));
      yield* TestClock.adjust("1 minute");
      assert.strictEqual(fetch.mock.calls.length, 2);
      yield* Fiber.join(operation);
      assert.strictEqual(onAbort.mock.calls.length, 1);
    }).pipe(withFetchClient(fetch));
  });

  it.effect("retries a read after its response body reaches the attempt deadline", () => {
    const response = vi
      .fn<() => Response>()
      .mockReturnValueOnce(hangingResponse("["))
      .mockReturnValue(jsonResponse([]));
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(response()));

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      const operation = yield* Effect.forkChild(client.listIssues(repo));
      yield* TestClock.adjust("1 minute");
      assert.strictEqual(fetch.mock.calls.length, 2);
      assert.deepStrictEqual(yield* Fiber.join(operation), []);
    }).pipe(withFetchClient(fetch));
  });

  it.effect("does not replay an accepted write whose response body stalls", () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(hangingResponse("{", 201)));

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      const operation = yield* Effect.forkChild(client.createComment(repo, 287, "claim"));
      yield* TestClock.adjust("1 minute");
      assert.strictEqual(fetch.mock.calls.length, 1);
      yield* Fiber.join(operation);
    }).pipe(withFetchClient(fetch));
  });

  it.effect("retries a transient label removal", () =>
    transientWrite(503, (client) => client.removeLabel(repo, 287, "cogwork:claimed")),
  );

  it.effect("retries a write rejected with a transient HTTP status", () =>
    transientWrite(408, (client) => client.createComment(repo, 287, "claim")),
  );

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
    const { client: httpClient, requests } = delayedJsonClient(() => page);

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      const error = yield* afterPaginationDeadline(
        Effect.flip(client.projectPriorities(repo, { project: 1 })),
      );
      assert.strictEqual(error.reason, "unavailable");
      assert.include(error.message, "pagination timed out");
      assert.isAbove(requests.mock.calls.length, 1);
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
    const { client: httpClient, requests } = delayedJsonClient((request) =>
      request.url.endsWith("/graphql") ? page : [],
    );

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      const error = yield* afterPaginationDeadline(Effect.flip(client.listPulls(repo)));
      assert.strictEqual(error.reason, "unavailable");
      assert.include(error.message, "pagination timed out");
      assert.isAbove(requests.mock.calls.length, 1);
    }).pipe(withHttpClient(httpClient));
  });

  it.effect("does not retry a rejected write", () => rejectedWrite(401, "auth"));

  it.effect("does not retry a permanent write failure", () => rejectedWrite(422, "unavailable"));
});
