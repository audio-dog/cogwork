import { issueTrackerErrorIsPermanent } from "@cogwork/contracts";
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

const hangingResponse = (prefix: string, status = 200, headers?: HeadersInit) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start: (controller) => controller.enqueue(new TextEncoder().encode(prefix)),
    }),
    { status, headers },
  );

const controlledJsonResponse = (status: number) => {
  const body = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
  const response = new Response(
    new ReadableStream<Uint8Array>({ start: (controller) => body.resolve(controller) }),
    { status, headers: { "content-type": "application/json" } },
  );
  return { body: body.promise, response };
};

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
  it.effect("reads the authenticated account login", () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(jsonResponse({ login: "connected-account" })),
    );

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      assert.strictEqual(yield* client.authenticatedLogin(repo), "connected-account");
      const [input, init] = fetch.mock.calls[0] ?? [];
      assert.isDefined(input);
      const request = new Request(input, init);
      assert.strictEqual(request.url, "https://api.github.com/user");
    }).pipe(withFetchClient(fetch));
  });

  it.effect("lists every open issue across GitHub pages", () => {
    const issue = (number: number) => ({ number, title: `issue ${number}`, labels: [] });
    const firstPage = Array.from({ length: 100 }, (_, index) => issue(index + 1));
    const fetch = vi.fn<typeof globalThis.fetch>((input) => {
      const url = input instanceof Request ? input.url : String(input);
      const page = new URL(url).searchParams.get("page");
      return Promise.resolve(jsonResponse(page === "1" ? firstPage : [issue(101)]));
    });

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      const issues = yield* client.listIssues(repo);
      assert.strictEqual(issues.length, 101);
      assert.strictEqual(issues.at(-1)?.number, 101);
      assert.deepStrictEqual(
        fetch.mock.calls.map(([input]) =>
          new URL(input instanceof Request ? input.url : String(input)).searchParams.get("page"),
        ),
        ["1", "2"],
      );
    }).pipe(withFetchClient(fetch));
  });

  it.effect("lists open and closed issues carrying one label", () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        jsonResponse([
          {
            number: 416,
            title: "Performance regression",
            body: "<!-- cogwork:selfperf fingerprint=daemon.heap-headroom.below -->",
            state: "closed",
            created_at: "2026-09-09T12:00:00Z",
            labels: ["origin:selfperf"],
          },
        ]),
      ),
    );

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      const issues = yield* client.listIssues(repo, { state: "all", label: "origin:selfperf" });
      const request = new URL(String(fetch.mock.calls[0]?.[0]));

      assert.strictEqual(request.searchParams.get("state"), "all");
      assert.strictEqual(request.searchParams.get("labels"), "origin:selfperf");
      assert.deepStrictEqual(issues, [
        {
          number: 416,
          title: "Performance regression",
          url: "https://github.com/colonylabs/cogwork/issues/416",
          labels: ["origin:selfperf"],
          assignees: [],
          isPullRequest: false,
          openBlockers: 0,
          body: "<!-- cogwork:selfperf fingerprint=daemon.heap-headroom.below -->",
          state: "closed",
          createdAtMillis: Date.UTC(2026, 8, 9, 12),
        },
      ]);
    }).pipe(withFetchClient(fetch));
  });

  it.effect(
    "filters open pull requests by the exact repository head without loading closing references",
    () => {
      const fetch = vi.fn<typeof globalThis.fetch>((input) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.endsWith("/graphql")) {
          return Promise.resolve(
            jsonResponse({
              data: {
                repository: {
                  pullRequests: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [],
                  },
                },
              },
            }),
          );
        }
        return Promise.resolve(jsonResponse([]));
      });

      return Effect.gen(function* () {
        const client = yield* GitHubClient;
        yield* client.listPulls(repo, "474-ready");
        const request = fetch.mock.calls
          .map(([input]) => new URL(input instanceof Request ? input.url : String(input)))
          .find((url) => url.pathname.endsWith("/pulls"));
        assert.strictEqual(fetch.mock.calls.length, 1);
        assert.strictEqual(request?.searchParams.get("head"), "colonylabs:474-ready");
        assert.strictEqual(request?.searchParams.get("state"), "open");
      }).pipe(withFetchClient(fetch));
    },
  );

  it.effect("creates an issue with its body and labels", () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        jsonResponse({ number: 415, labels: [{ name: "needs-triage" }, { name: "origin:selfperf" }] }, 201),
      ),
    );

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      yield* client.createIssue(repo, {
        title: "Daemon event loop delay is high",
        body: "Signal: event-loop-delay",
        labels: ["needs-triage", "origin:selfperf"],
      });

      assert.strictEqual(fetch.mock.calls.length, 1);
      const [input, init] = fetch.mock.calls[0] ?? [];
      assert.isDefined(input);
      const request = new Request(input, init);
      assert.strictEqual(request.method, "POST");
      assert.strictEqual(request.url, "https://api.github.com/repos/colonylabs/cogwork/issues");
      assert.strictEqual(request.headers.get("authorization"), "Bearer test-token");
      assert.deepStrictEqual(yield* Effect.promise(() => request.json()), {
        title: "Daemon event loop delay is high",
        body: "Signal: event-loop-delay",
        labels: ["needs-triage", "origin:selfperf"],
      });
    }).pipe(withFetchClient(fetch));
  });

  it.effect("opens a pull request and returns its number and URL", () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        jsonResponse({ number: 480, html_url: "https://github.com/colonylabs/cogwork/pull/480" }, 201),
      ),
    );

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      const opened = yield* client.createPull(repo, {
        headBranch: "472-open-pull-request",
        baseBranch: "main",
        title: "Open pull requests from the engine",
        body: "Closes #472",
      });

      assert.deepStrictEqual(opened, {
        number: 480,
        url: "https://github.com/colonylabs/cogwork/pull/480",
      });
      assert.strictEqual(fetch.mock.calls.length, 1);
      const [input, init] = fetch.mock.calls[0] ?? [];
      assert.isDefined(input);
      const request = new Request(input, init);
      assert.strictEqual(request.method, "POST");
      assert.strictEqual(request.url, "https://api.github.com/repos/colonylabs/cogwork/pulls");
      assert.strictEqual(request.headers.get("authorization"), "Bearer test-token");
      assert.deepStrictEqual(yield* Effect.promise(() => request.json()), {
        head: "472-open-pull-request",
        base: "main",
        title: "Open pull requests from the engine",
        body: "Closes #472",
      });
    }).pipe(withFetchClient(fetch));
  });

  it.effect("surfaces a rejected pull request write as a typed error", () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(jsonResponse({}, 422)));

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      const error = yield* Effect.flip(
        client.createPull(repo, {
          headBranch: "472-open-pull-request",
          baseBranch: "main",
          title: "Open pull requests from the engine",
          body: "Closes #472",
        }),
      );
      assert.strictEqual(error.reason, "unavailable");
      assert.strictEqual(fetch.mock.calls.length, 1);
    }).pipe(withFetchClient(fetch));
  });

  it.effect("recovers an accepted pull request when its response body stalls", () => {
    const response = vi
      .fn<() => Response>()
      .mockReturnValueOnce(hangingResponse("{", 201))
      .mockReturnValue(
        jsonResponse([{ number: 480, html_url: "https://github.com/colonylabs/cogwork/pull/480" }]),
      );
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(response()));

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      const operation = yield* Effect.forkChild(
        client.createPull(repo, {
          headBranch: "472-open-pull-request",
          baseBranch: "main",
          title: "Open pull requests from the engine",
          body: "Closes #472",
        }),
      );
      yield* TestClock.adjust("1 minute");
      assert.deepStrictEqual(yield* Fiber.join(operation), {
        number: 480,
        url: "https://github.com/colonylabs/cogwork/pull/480",
      });
      assert.strictEqual(fetch.mock.calls.length, 2);
      const requests = fetch.mock.calls.map(([input, init]) => new Request(input, init));
      assert.deepStrictEqual(
        requests.map((request) => request.method),
        ["POST", "GET"],
      );
      assert.strictEqual(
        requests[1]?.url,
        "https://api.github.com/repos/colonylabs/cogwork/pulls?state=open&head=colonylabs%3A472-open-pull-request&base=main&per_page=1",
      );
    }).pipe(withFetchClient(fetch));
  });

  it.effect("applies labels that GitHub silently drops during issue creation", () => {
    const response = vi
      .fn<() => Response>()
      .mockReturnValueOnce(jsonResponse({ number: 415, labels: [] }, 201))
      .mockReturnValue(jsonResponse([]));
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(response()));

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      yield* client.createIssue(repo, {
        title: "Daemon event loop delay is high",
        body: "Signal: event-loop-delay",
        labels: ["needs-triage", "origin:selfperf"],
      });

      assert.strictEqual(fetch.mock.calls.length, 3);
      const requests = fetch.mock.calls.map(([input, init]) => new Request(input, init));
      assert.deepStrictEqual(
        requests.map((request) => request.url),
        [
          "https://api.github.com/repos/colonylabs/cogwork/issues",
          "https://api.github.com/repos/colonylabs/cogwork/issues/415/labels",
          "https://api.github.com/repos/colonylabs/cogwork/issues/415/labels",
        ],
      );
      assert.deepStrictEqual(yield* Effect.promise(() => requests[1]?.json()), {
        labels: ["needs-triage"],
      });
      assert.deepStrictEqual(yield* Effect.promise(() => requests[2]?.json()), {
        labels: ["origin:selfperf"],
      });
    }).pipe(withFetchClient(fetch));
  });

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

  it.effect("does not fail an accepted issue creation whose response body stalls", () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(hangingResponse("{", 201)));

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      const operation = yield* Effect.forkChild(
        client.createIssue(repo, {
          title: "Daemon event loop delay is high",
          body: "Signal: event-loop-delay",
          labels: ["needs-triage", "origin:selfperf"],
        }),
      );
      yield* TestClock.adjust("1 minute");
      assert.strictEqual(fetch.mock.calls.length, 1);
      yield* Fiber.join(operation);
    }).pipe(withFetchClient(fetch));
  });

  it.effect("retries a transient label removal", () =>
    transientWrite(503, (client) => client.removeLabel(repo, 287, "cogwork:claimed")),
  );

  it.effect("does not replay a transient issue creation failure", () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(jsonResponse({}, 503)));

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      const error = yield* Effect.flip(
        client.createIssue(repo, {
          title: "Daemon event loop delay is high",
          body: "Signal: event-loop-delay",
          labels: ["needs-triage", "origin:selfperf"],
        }),
      );
      assert.strictEqual(error.reason, "unavailable");
      assert.strictEqual(fetch.mock.calls.length, 1);
    }).pipe(withFetchClient(fetch));
  });

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

  it.effect("marks a refused write permanent", () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(jsonResponse({ message: "Resource not accessible by integration" }, 403)),
    );

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      const error = yield* Effect.flip(client.createComment(repo, 287, "claim"));
      assert.strictEqual(error.reason, "unavailable");
      assert.strictEqual(error.retryable, false);
      assert.isTrue(issueTrackerErrorIsPermanent(error));
    }).pipe(withFetchClient(fetch));
  });

  it.effect("keeps a throttled write non-permanent", () => {
    const response = jsonResponse(
      { message: "You have exceeded a secondary rate limit. Please wait before retrying." },
      403,
    );
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(response));

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      const error = yield* Effect.flip(client.createComment(repo, 287, "claim"));
      assert.strictEqual(error.reason, "rate-limited");
      assert.isFalse(issueTrackerErrorIsPermanent(error));
    }).pipe(withFetchClient(fetch));
  });

  it.effect("uses the default cooldown for a secondary limit without retry-after", () => {
    const response = vi
      .fn<() => Response>()
      .mockReturnValueOnce(
        new Response(
          JSON.stringify({
            message: "You have exceeded a secondary rate limit. Please wait before retrying.",
          }),
          {
            status: 403,
            headers: {
              "content-type": "application/json",
              "x-ratelimit-reset": "4102444800",
            },
          },
        ),
      )
      .mockReturnValue(jsonResponse());
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(response()));

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      yield* Effect.flip(client.createComment(repo, 287, "claim"));
      yield* TestClock.adjust("1 minute");
      yield* client.createComment(repo, 287, "claim");
      assert.strictEqual(fetch.mock.calls.length, 2);
    }).pipe(withFetchClient(fetch));
  });

  it.effect("waits for a slow secondary-limit response body", () => {
    const { body, response } = controlledJsonResponse(403);
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(response));

    return Effect.gen(function* () {
      const controller = yield* Effect.promise(() => body);
      const client = yield* GitHubClient;
      const operation = yield* Effect.forkChild(client.createComment(repo, 287, "claim"));
      yield* TestClock.adjust("2 seconds");
      controller.enqueue(
        new TextEncoder().encode(
          '{"message":"You have exceeded a secondary rate limit. Please wait before retrying."}',
        ),
      );
      controller.close();
      const error = yield* Effect.flip(Fiber.join(operation));
      assert.strictEqual(error.reason, "rate-limited");
      assert.isFalse(issueTrackerErrorIsPermanent(error));
    }).pipe(withFetchClient(fetch));
  });

  it.effect("keeps an unreadable forbidden response non-permanent", () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(hangingResponse("{", 403, { "x-accepted-github-permissions": "issues=write" })),
    );

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      const operation = yield* Effect.forkChild(client.createComment(repo, 287, "claim"));
      yield* TestClock.adjust("3 minutes");
      const error = yield* Effect.flip(Fiber.join(operation));
      assert.isFalse(issueTrackerErrorIsPermanent(error));
      assert.strictEqual(fetch.mock.calls.length, 1);
    }).pipe(withFetchClient(fetch));
  });

  it.effect("does not retry a permanent write failure", () => rejectedWrite(422, "unavailable"));
});
