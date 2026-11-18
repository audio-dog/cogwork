import { GitHubIssueFieldId, issueTrackerErrorIsPermanent } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { TestClock } from "effect/testing";
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
const priorityFieldId = Schema.decodeSync(GitHubIssueFieldId)(42);
const secondaryFieldId = Schema.decodeSync(GitHubIssueFieldId)(43);

const jsonResponse = (body: unknown = {}, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const pullResponse = (number: number) => ({
  number,
  title: `Pull ${number}`,
  html_url: `https://github.com/colonylabs/cogwork/pull/${number}`,
  user: { login: "cogwork[bot]" },
  head: {
    sha: `sha-${number}`,
    ref: `${number}-work-item`,
    repo: { full_name: "colonylabs/cogwork" },
  },
  author_association: "MEMBER",
});

const issueResponse = (number: number, labels: ReadonlyArray<string> = []) => ({
  node_id: `I_issue_${number}`,
  number,
  title: "Daemon event loop delay is high",
  html_url: `https://github.com/colonylabs/cogwork/issues/${number}`,
  labels,
  assignees: [],
  body: "Signal: event-loop-delay",
  state: "open",
  created_at: "2026-09-09T12:00:00Z",
});

const emptyClosingReferences = {
  data: {
    repository: {
      pullRequests: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [],
      },
    },
  },
};

const pullPageLink = (page: number) =>
  `<https://api.github.com/repositories/1333127441/pulls?state=open&per_page=100&sort=updated&direction=desc&page=${page}>; rel="next"`;

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
    const issue = (number: number) => ({
      node_id: `I_issue_${number}`,
      number,
      title: `issue ${number}`,
      labels: [],
      body: null,
      state: "open",
      created_at: "2026-09-09T12:00:00Z",
    });
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
      assert.strictEqual(issues.at(-1)?.nodeId, "I_issue_101");
      assert.deepStrictEqual(
        fetch.mock.calls.map(([input]) =>
          new URL(input instanceof Request ? input.url : String(input)).searchParams.get("page"),
        ),
        ["1", "2"],
      );
    }).pipe(withFetchClient(fetch));
  });

  it.effect("lists every check run across GitHub pages", () => {
    const check = (name: string) => ({
      name,
      status: "completed",
      conclusion: "failure",
      started_at: "2026-09-09T12:00:00Z",
      completed_at: "2026-09-09T12:01:00Z",
    });
    const firstPage = Array.from({ length: 100 }, (_, index) => check(`check-${index + 1}`));
    const fetch = vi.fn<typeof globalThis.fetch>((input) => {
      const url = input instanceof Request ? input.url : String(input);
      const page = new URL(url).searchParams.get("page");
      return Promise.resolve(jsonResponse({ check_runs: page === "1" ? firstPage : [check("check-101")] }));
    });

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      const checks = yield* client.listCheckRuns(repo, "head-sha");

      assert.strictEqual(checks.length, 101);
      assert.strictEqual(checks.at(-1)?.name, "check-101");
      assert.deepStrictEqual(
        fetch.mock.calls.map(([input]) =>
          new URL(input instanceof Request ? input.url : String(input)).searchParams.get("page"),
        ),
        ["1", "2"],
      );
    }).pipe(withFetchClient(fetch));
  });

  it.effect("continues review-comment pagination past empty bodies and deleted accounts", () => {
    const maintainer = { login: "maintainer", type: "User" };
    const comment = (id: number, body: string | null, user: typeof maintainer | null = maintainer) => ({
      id,
      body,
      created_at: "2026-09-09T12:00:00Z",
      author_association: "MEMBER",
      user,
      in_reply_to_id: null,
      subject_type: "line",
    });
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      comment(index + 1, index === 0 ? null : `comment ${index + 1}`, index === 1 ? null : maintainer),
    );
    const fetch = vi.fn<typeof globalThis.fetch>((input) => {
      const url = input instanceof Request ? input.url : String(input);
      const page = new URL(url).searchParams.get("page");
      return Promise.resolve(jsonResponse(page === "1" ? firstPage : [comment(101, "last")]));
    });

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      const comments = yield* client.listReviewComments(repo, 850);

      assert.strictEqual(comments.length, 99);
      assert.notInclude(
        comments.map(({ id }) => id),
        2,
      );
      assert.strictEqual(comments.at(-1)?.id, 101);
      assert.deepStrictEqual(
        fetch.mock.calls.map(([input]) =>
          new URL(input instanceof Request ? input.url : String(input)).searchParams.get("page"),
        ),
        ["1", "2"],
      );
    }).pipe(withFetchClient(fetch));
  });

  it.effect("continues review pagination past deleted accounts", () => {
    const review = (id: number, user: { readonly login: string; readonly type: string } | null) => ({
      id,
      state: "COMMENTED",
      user,
      body: `review ${id}`,
      author_association: "MEMBER",
      submitted_at: "2026-09-09T12:00:00Z",
    });
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      review(index + 1, index === 0 ? null : { login: "maintainer", type: "User" }),
    );
    const fetch = vi.fn<typeof globalThis.fetch>((input) => {
      const url = input instanceof Request ? input.url : String(input);
      const page = new URL(url).searchParams.get("page");
      return Promise.resolve(
        jsonResponse(page === "1" ? firstPage : [review(101, { login: "maintainer", type: "User" })]),
      );
    });

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      const reviews = yield* client.listReviews(repo, 850);

      assert.strictEqual(reviews.length, 100);
      assert.strictEqual(reviews[0]?.id, 2);
      assert.strictEqual(reviews.at(-1)?.id, 101);
    }).pipe(withFetchClient(fetch));
  });

  it.effect("preserves review ids", () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        jsonResponse([
          {
            id: 123,
            state: "COMMENTED",
            user: { login: "maintainer", type: "User" },
            body: "Review body",
            author_association: "MEMBER",
            submitted_at: "2026-09-09T12:00:00Z",
          },
        ]),
      ),
    );

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      const reviews = yield* client.listReviews(repo, 850);

      assert.strictEqual(reviews[0]?.id, 123);
    }).pipe(withFetchClient(fetch));
  });

  it.effect("lists open and closed issues carrying one label", () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        jsonResponse([
          {
            node_id: "I_issue_416",
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
          nodeId: "I_issue_416",
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
          updatedAtMillis: Date.UTC(2026, 8, 9, 12),
        },
      ]);
    }).pipe(withFetchClient(fetch));
  });

  it.effect("finds one issue by body marker", () => {
    const marker = "<!-- cogwork:write key=create-key -->";
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        jsonResponse({
          items: [
            { ...issueResponse(415), body: "<!-- cogwork:write key=another-create-key -->" },
            { ...issueResponse(416), body: marker },
          ],
        }),
      ),
    );

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      const issue = yield* client.findIssueWithMarker(repo, marker);
      const [input] = fetch.mock.calls[0] ?? [];
      assert.isDefined(input);
      const request = new URL(input instanceof Request ? input.url : String(input));

      assert.strictEqual(issue?.number, 416);
      assert.strictEqual(request.pathname, "/search/issues");
      assert.strictEqual(
        request.searchParams.get("q"),
        `repo:colonylabs/cogwork is:issue in:body "${marker}"`,
      );
      assert.strictEqual(request.searchParams.get("per_page"), "100");
    }).pipe(withFetchClient(fetch));
  });

  it.effect("refreshes a body marker search after an earlier miss", () => {
    const marker = "<!-- cogwork:write key=create-key -->";
    const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
      const request = new Request(input, init);
      if (fetch.mock.calls.length === 1) {
        return Promise.resolve(jsonResponse({ items: [] }, 200, { etag: '"empty"' }));
      }
      return Promise.resolve(
        request.headers.has("if-none-match")
          ? new Response(null, { status: 304 })
          : jsonResponse({ items: [{ ...issueResponse(416), body: marker }] }),
      );
    });

    return Effect.gen(function* () {
      const client = yield* GitHubClient;

      assert.isNull(yield* client.findIssueWithMarker(repo, marker));
      assert.strictEqual((yield* client.findIssueWithMarker(repo, marker))?.number, 416);
    }).pipe(withFetchClient(fetch));
  });

  it.effect("reads pull request references with an empty body", () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        jsonResponse({
          data: {
            repository: {
              issue: {
                timelineItems: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      source: {
                        body: null,
                        merged: true,
                        repository: { nameWithOwner: "colonylabs/cogwork" },
                      },
                    },
                  ],
                },
              },
            },
          },
        }),
      ),
    );

    return Effect.gen(function* () {
      const client = yield* GitHubClient;

      assert.deepStrictEqual(yield* client.issuePullReferences(repo, 416), [
        { body: "", merged: true, repository: "colonylabs/cogwork" },
      ]);
    }).pipe(withFetchClient(fetch));
  });

  it.effect("rejects issue history without state and creation time", () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        jsonResponse([
          {
            node_id: "I_issue_416",
            number: 416,
            title: "Performance regression",
            labels: [],
            body: null,
          },
        ]),
      ),
    );

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      const error = yield* Effect.flip(client.listIssues(repo, { state: "all" }));
      assert.strictEqual(error.reason, "unavailable");
    }).pipe(withFetchClient(fetch));
  });

  it.effect("lists issue field values in one GraphQL request and keeps partial results", () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        jsonResponse({
          data: {
            nodes: [
              {
                id: "I_issue_454",
                number: 454,
                issueFieldValues: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      __typename: "IssueFieldSingleSelectValue",
                      name: "Urgent",
                      field: { fullDatabaseId: "42" },
                    },
                    { __typename: "IssueFieldDateValue" },
                  ],
                },
              },
              null,
            ],
          },
        }),
      ),
    );

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      assert.deepStrictEqual(
        yield* client.listIssueFieldValues(repo, ["I_issue_454", "I_missing"]),
        new Map([[454, new Map([[priorityFieldId, "Urgent"]])]]),
      );
      assert.strictEqual(fetch.mock.calls.length, 1);
      const [input, init] = fetch.mock.calls[0] ?? [];
      assert.isDefined(input);
      const request = new Request(input, init);
      assert.strictEqual(request.url, "https://api.github.com/graphql");
      const body = yield* Effect.promise(() => request.json());
      assert.deepStrictEqual(body.variables, { ids: ["I_issue_454", "I_missing"] });
    }).pipe(withFetchClient(fetch));
  });

  it.effect("lists every issue field value page", () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            nodes: [
              {
                id: "I_issue_454",
                number: 454,
                issueFieldValues: {
                  pageInfo: { hasNextPage: true, endCursor: "cursor-454" },
                  nodes: [
                    {
                      __typename: "IssueFieldSingleSelectValue",
                      name: "High",
                      field: { fullDatabaseId: "43" },
                    },
                  ],
                },
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            issue0: {
              id: "I_issue_454",
              number: 454,
              issueFieldValues: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    __typename: "IssueFieldSingleSelectValue",
                    name: "Urgent",
                    field: { fullDatabaseId: "42" },
                  },
                ],
              },
            },
          },
        }),
      );

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      assert.deepStrictEqual(
        yield* client.listIssueFieldValues(repo, ["I_issue_454"]),
        new Map([
          [
            454,
            new Map([
              [secondaryFieldId, "High"],
              [priorityFieldId, "Urgent"],
            ]),
          ],
        ]),
      );
      assert.strictEqual(fetch.mock.calls.length, 2);
      const bodies = yield* Effect.forEach(fetch.mock.calls, ([input, init]) => {
        const request = new Request(input, init);
        return Effect.promise(() => request.json());
      });
      assert.deepStrictEqual(
        bodies.map(({ variables }) => variables),
        [{ ids: ["I_issue_454"] }, { id0: "I_issue_454", cursor0: "cursor-454" }],
      );
    }).pipe(withFetchClient(fetch));
  });

  it.effect("lists compatible organization issue fields by stable ID", () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        jsonResponse([
          { id: 42, name: "Priority", data_type: "single_select" },
          { id: 43, name: "Target date", data_type: "date" },
        ]),
      ),
    );

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      assert.deepStrictEqual(yield* client.listPriorityFields(repo), [{ id: 42, name: "Priority" }]);
      const [input, init] = fetch.mock.calls[0] ?? [];
      assert.isDefined(input);
      const request = new Request(input, init);
      assert.strictEqual(request.url, "https://api.github.com/orgs/colonylabs/issue-fields");
      assert.strictEqual(request.headers.get("x-github-api-version"), "2026-03-10");
    }).pipe(withFetchClient(fetch));
  });

  it.effect("names the permission needed when the issue field catalog is unavailable", () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(jsonResponse({ message: "Resource not accessible by integration" }, 403)),
    );

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      const error = yield* Effect.flip(client.listPriorityFields(repo));
      assert.include(error.message, "read:org or Issue Fields read permission");
      assert.isFalse(error.retryable ?? true);
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

  it.effect("lists every open pull request once across GitHub pages", () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => pullResponse(index + 1));
    const fetch = vi.fn<typeof globalThis.fetch>((input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith("/graphql")) return Promise.resolve(jsonResponse(emptyClosingReferences));
      if (url.searchParams.get("page") === "2") {
        return Promise.resolve(jsonResponse([pullResponse(100), pullResponse(101)]));
      }
      return Promise.resolve(
        jsonResponse(firstPage, 200, {
          link: pullPageLink(2),
        }),
      );
    });

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      const pulls = yield* client.listPulls(repo);

      assert.strictEqual(pulls.length, 101);
      assert.strictEqual(pulls.at(-1)?.number, 101);
    }).pipe(withFetchClient(fetch));
  });

  it.effect("lists open pull requests from a repository smaller than one page", () => {
    const fetch = vi.fn<typeof globalThis.fetch>((input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith("/graphql")) return Promise.resolve(jsonResponse(emptyClosingReferences));
      return Promise.resolve(jsonResponse([pullResponse(1)]));
    });

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      const pulls = yield* client.listPulls(repo);

      assert.deepStrictEqual(
        pulls.map((pull) => pull.number),
        [1],
      );
    }).pipe(withFetchClient(fetch));
  });

  it.effect("creates an issue with its body and labels", () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(jsonResponse(issueResponse(415, ["needs-triage", "origin:selfperf"]), 201)),
    );

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      const created = yield* client.createIssue(repo, {
        title: "Daemon event loop delay is high",
        body: "Signal: event-loop-delay",
        labels: ["needs-triage", "origin:selfperf"],
      });

      assert.strictEqual(created.number, 415);
      assert.strictEqual(created.body, "Signal: event-loop-delay");
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

  it.effect("creates a pending review by omitting event", () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(jsonResponse({ id: 91 }, 200)));

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      yield* client.createReview(repo, 480, {
        commitId: "reviewed-sha",
        body: "Review draft",
        comments: [{ path: "src/index.ts", line: 12, body: "Please rename this." }],
        event: null,
      });

      const [input, init] = fetch.mock.calls[0] ?? [];
      assert.isDefined(input);
      const request = new Request(input, init);
      assert.strictEqual(request.method, "POST");
      assert.strictEqual(request.url, "https://api.github.com/repos/colonylabs/cogwork/pulls/480/reviews");
      assert.deepStrictEqual(yield* Effect.promise(() => request.json()), {
        commit_id: "reviewed-sha",
        body: "Review draft",
        comments: [{ path: "src/index.ts", line: 12, side: "RIGHT", body: "Please rename this." }],
      });
    }).pipe(withFetchClient(fetch));
  });

  it.effect("does not retry a review when the response is lost", () => {
    const status = vi.fn().mockReturnValueOnce(500).mockReturnValue(201);
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(jsonResponse({}, status())));

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      const operation = yield* Effect.forkChild(
        Effect.result(
          client.createReview(repo, 480, {
            commitId: "reviewed-sha",
            body: "Review body",
            comments: [],
            event: "COMMENT",
          }),
        ),
      );
      yield* TestClock.adjust("1 second");
      const result = yield* Fiber.join(operation);

      assert.isTrue(Result.isFailure(result));
      assert.strictEqual(fetch.mock.calls.length, 1);
    }).pipe(withFetchClient(fetch));
  });

  it.effect("reads pull request description, diff, and changed files", () => {
    const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
      const request = new Request(input, init);
      if (request.headers.get("accept") === "application/vnd.github.v3.diff") {
        return Promise.resolve(new Response("diff --git a/src/index.ts b/src/index.ts\n"));
      }
      if (request.url.endsWith("/compare/base-sha...head-sha")) {
        return Promise.resolve(
          jsonResponse({
            files: [
              {
                filename: "src/index.ts",
                status: "modified",
                additions: 1,
                deletions: 0,
                changes: 1,
                patch: "@@ -10,0 +11,1 @@\n+const answer = 42;",
              },
            ],
          }),
        );
      }
      return Promise.resolve(
        jsonResponse({
          ...pullResponse(480),
          title: "Review this change",
          body: "Please review the implementation.",
          base: { sha: "base-sha", ref: "main" },
        }),
      );
    });

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      const [pull, diff, files] = yield* Effect.all([
        client.getPull(repo, 480),
        client.getPullDiff(repo, "base-sha", "head-sha"),
        client.listPullFiles(repo, "base-sha", "head-sha"),
      ]);

      assert.strictEqual(pull.title, "Review this change");
      assert.strictEqual(pull.body, "Please review the implementation.");
      assert.strictEqual(diff, "diff --git a/src/index.ts b/src/index.ts\n");
      assert.deepStrictEqual(files, [
        {
          path: "src/index.ts",
          status: "modified",
          additions: 1,
          deletions: 0,
          changes: 1,
          patch: "@@ -10,0 +11,1 @@\n+const answer = 42;",
        },
      ]);
      assert.deepStrictEqual(
        fetch.mock.calls.map(([input, init]) => new Request(input, init).url),
        [
          "https://api.github.com/repos/colonylabs/cogwork/pulls/480",
          "https://api.github.com/repos/colonylabs/cogwork/compare/base-sha...head-sha",
          "https://api.github.com/repos/colonylabs/cogwork/compare/base-sha...head-sha",
        ],
      );
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
      .mockReturnValueOnce(jsonResponse(issueResponse(415), 201))
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

  it.effect("marks label repair failures as possibly committed issue writes", () => {
    const response = vi
      .fn<() => Response>()
      .mockReturnValueOnce(jsonResponse(issueResponse(415), 201))
      .mockReturnValue(jsonResponse({ message: "Validation failed" }, 422));
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(response()));

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      const error = yield* Effect.flip(
        client.createIssue(repo, {
          title: "Daemon event loop delay is high",
          body: "Signal: event-loop-delay",
          labels: ["needs-triage", "origin:selfperf"],
        }),
      );

      assert.isTrue(error.writeMayHaveCommitted);
      assert.strictEqual(fetch.mock.calls.length, 2);
    }).pipe(withFetchClient(fetch));
  });

  it.effect("reports an ambiguous coordination comment without replaying it", () => {
    const onAbort = vi.fn();
    const fetch = vi.fn<typeof globalThis.fetch>((_input, init) => {
      init?.signal?.addEventListener("abort", onAbort);
      return Promise.withResolvers<Response>().promise;
    });

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      const operation = yield* Effect.forkChild(client.createComment(repo, 287, "claim"));
      yield* TestClock.adjust("1 minute");
      assert.strictEqual(fetch.mock.calls.length, 1);
      const error = yield* Effect.flip(Fiber.join(operation));
      assert.strictEqual(error.reason, "unavailable");
      assert.strictEqual(onAbort.mock.calls.length, 1);
    }).pipe(withFetchClient(fetch));
  });

  it.effect("accepts an ambiguous performance comment without replaying it", () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.withResolvers<Response>().promise);

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      const operation = yield* Effect.forkChild(client.createPerformanceComment(repo, 287, "recurrence"));
      yield* TestClock.adjust("1 minute");
      yield* Fiber.join(operation);
      assert.strictEqual(fetch.mock.calls.length, 1);
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

  it.effect("completes an accepted comment write without reading its response body", () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(hangingResponse("{", 201)));

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      const operation = yield* Effect.forkChild(client.createComment(repo, 287, "claim"));
      yield* TestClock.adjust("1 second");
      assert.strictEqual(fetch.mock.calls.length, 1);
      assert.isDefined(operation.pollUnsafe());
    }).pipe(withFetchClient(fetch));
  });

  it.effect("reports an accepted issue creation whose response body stalls", () => {
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
      const error = yield* Effect.flip(Fiber.join(operation));
      assert.isTrue(error.writeMayHaveCommitted);
    }).pipe(withFetchClient(fetch));
  });

  it.effect("retries a transient label removal", () =>
    transientWrite(503, (client) => client.removeLabel(repo, 287, "cogwork:claimed")),
  );

  it.effect("accepts removal when the issue no longer has the label", () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(jsonResponse({}, 404)));

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      yield* client.removeLabel(repo, 287, "ready-for-agent");
      assert.strictEqual(fetch.mock.calls.length, 1);
    }).pipe(withFetchClient(fetch));
  });

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

  it.effect("retries an idempotent write rejected with a transient HTTP status", () =>
    transientWrite(408, (client) => client.editComment(repo, 287, "claim")),
  );

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
    const { client: httpClient } = delayedJsonClient((request) =>
      request.url.endsWith("/graphql") ? page : [],
    );

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      const error = yield* afterPaginationDeadline(Effect.flip(client.listPulls(repo)));
      assert.strictEqual(error.reason, "unavailable");
      assert.include(error.message, "pagination timed out");
    }).pipe(withHttpClient(httpClient));
  });

  it.effect("lists collaborators from every page", () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({ login: `reviewer-${index}` }));
    const fetch = vi.fn<typeof globalThis.fetch>((input) => {
      const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
      const page = new URL(url).searchParams.get("page");
      return Promise.resolve(jsonResponse(page === "1" ? firstPage : [{ login: "reviewer-100" }]));
    });

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      const reviewers = yield* client.listCollaborators(repo);
      assert.lengthOf(reviewers, 101);
      assert.strictEqual(reviewers.at(-1), "reviewer-100");
      assert.strictEqual(fetch.mock.calls.length, 2);
    }).pipe(withFetchClient(fetch));
  });

  it.effect("lists assignable users from every page", () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({ login: `assignee-${index}` }));
    const fetch = vi.fn<typeof globalThis.fetch>((input) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
      if (!url.pathname.endsWith("/assignees")) return Promise.resolve(jsonResponse([], 404));
      return Promise.resolve(
        jsonResponse(url.searchParams.get("page") === "1" ? firstPage : [{ login: "taylor" }]),
      );
    });

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      const assignees = yield* client.listAssignees(repo);
      assert.lengthOf(assignees, 101);
      assert.strictEqual(assignees.at(-1), "taylor");
    }).pipe(withFetchClient(fetch));
  });

  it.effect("lists repository labels from every page", () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      name: `label-${index}`,
      color: "ededed",
    }));
    const fetch = vi.fn<typeof globalThis.fetch>((input) => {
      const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
      const page = new URL(url).searchParams.get("page");
      return Promise.resolve(jsonResponse(page === "1" ? firstPage : [{ name: "needs-triage" }]));
    });

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      const labels = yield* client.listLabels(repo);
      assert.lengthOf(labels, 101);
      assert.strictEqual(labels.at(-1), "needs-triage");
      assert.strictEqual(fetch.mock.calls.length, 2);
    }).pipe(withFetchClient(fetch));
  });

  it.effect("fails an open-pull pagination timeout without returning a partial page", () => {
    const respond = (request: HttpClientRequest.HttpClientRequest) => {
      const currentPage = Number(new URL(request.url).searchParams.get("page") ?? "1");
      return HttpClientResponse.fromWeb(
        request,
        jsonResponse([pullResponse(currentPage)], 200, { link: pullPageLink(currentPage + 1) }),
      );
    };
    const httpClient = HttpClient.make((request) =>
      Effect.sleep("20 seconds").pipe(Effect.map(() => respond(request))),
    );

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      const error = yield* afterPaginationDeadline(Effect.flip(client.listPulls(repo)));
      assert.strictEqual(error.reason, "unavailable");
      assert.include(error.message, "pagination timed out");
    }).pipe(withHttpClient(httpClient));
  });

  it.effect("rejects a repeated open-pull pagination link", () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(jsonResponse([pullResponse(1)], 200, { link: pullPageLink(2) })),
    );

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      const error = yield* Effect.flip(client.listPulls(repo));
      assert.strictEqual(error.reason, "unavailable");
      assert.include(error.message, "repeated next link");
    }).pipe(withFetchClient(fetch));
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
