import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import { afterEach, vi } from "vitest";
import { CredentialError, type CredentialSource, CredentialStore } from "../credential-store";
import { layer as clientLayer, LinearClient, type LinearTeamRef } from "./client";

const ref: LinearTeamRef = {
  team: "AUD",
  account: {
    key: "AUD",
    issueTracker: "linear",
    organization: null,
    tokenEnv: "LINEAR_API_KEY",
    clientCredentials: null,
    oauthClientId: null,
  },
};

const linearMaxQueryComplexity = 10_000;
const linearDefaultPageSize = 50;
const objectPoints = 1;
const propertyPoints = 0.1;
const propertiesPerIssue = 5;
const propertiesPerCoordinationComment = 4;
const propertiesPerRelation = 2;
const objectsPerRelation = 2;

const connectionPattern = /(?:(\w+):\s*)?(\w+)\s*(?:\(([^)]*)\))?\s*\{\s*nodes\b/g;

const connectionsOf = (document: string) =>
  [...document.matchAll(connectionPattern)].map(([, alias, field, args]) => {
    const size = /\b(?:first|last):\s*(\d+)/.exec(args ?? "");
    return { name: alias ?? field ?? "", pageSize: size ? Number(size[1]) : linearDefaultPageSize };
  });

const pageSizesOf = (document: string) =>
  new Map(connectionsOf(document).map(({ name, pageSize }) => [name, pageSize]));

const connectionPoints = (pageSize: number, nodePoints: number) => pageSize * (objectPoints + nodePoints);

const complexityOf = (document: string) => {
  const pageSizes = pageSizesOf(document);
  const sizeOf = (name: string) => pageSizes.get(name) ?? 1;
  const commentPoints = propertiesPerCoordinationComment * propertyPoints + objectPoints;
  const relationPoints = propertiesPerRelation * propertyPoints + objectsPerRelation * objectPoints;
  const issuePoints =
    propertiesPerIssue * propertyPoints +
    objectPoints +
    connectionPoints(sizeOf("labels"), propertyPoints) +
    connectionPoints(sizeOf("comments"), commentPoints) +
    connectionPoints(sizeOf("proposalComments"), commentPoints) +
    connectionPoints(sizeOf("inverseRelations"), relationPoints);
  const teamPoints = connectionPoints(sizeOf("issues"), issuePoints);
  return Math.ceil(connectionPoints(sizeOf("teams"), teamPoints));
};

interface StubResponse {
  readonly status?: number;
  readonly body: unknown;
  readonly headers?: Record<string, string>;
}

const requestOf = (init: RequestInit | undefined) => {
  const body = init?.body;
  if (typeof body !== "string") return { query: "", variables: {} };
  const parsed: { readonly query?: string; readonly variables?: Record<string, unknown> } = JSON.parse(body);
  return { query: parsed.query ?? "", variables: parsed.variables ?? {} };
};

const documentOf = (init: RequestInit | undefined) => requestOf(init).query;

const stubLinear = (route: (document: string) => StubResponse) => {
  const fetchStub = vi.fn((_input: unknown, init?: RequestInit) => {
    const { status = 200, body, headers = {} } = route(documentOf(init));
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...headers },
      }),
    );
  });
  vi.stubGlobal("fetch", fetchStub);
  return fetchStub;
};

const sentRequests = (fetchStub: { readonly mock: { readonly calls: ReadonlyArray<unknown> } }) =>
  fetchStub.mock.calls.map((call) => requestOf((call as [unknown, RequestInit | undefined])[1]));

const authorizationOf = (fetchStub: { readonly mock: { readonly calls: ReadonlyArray<unknown> } }) => {
  const [, init] = (fetchStub.mock.calls[0] ?? []) as [unknown, RequestInit | undefined];
  return new Headers(init?.headers).get("authorization");
};

const stubCredentials = (token: string | null, source: CredentialSource, invalidated: Array<string>) =>
  Layer.succeed(CredentialStore, {
    bearerToken: (account) =>
      token === null
        ? Effect.fail(
            new CredentialError({
              account: account.key,
              message: `no credential for ${account.key}: ${account.tokenEnv} is unset or empty`,
            }),
          )
        : Effect.succeed({ source, token: Redacted.make(token), identity: null }),
    persist: () => Effect.void,
    invalidate: (account) => Effect.sync(() => invalidated.push(account.key)),
    providerKey: (account) =>
      Effect.fail(new CredentialError({ account: account.provider, message: "unused in this test" })),
    persistProviderKey: (key) =>
      Effect.fail(new CredentialError({ account: key.provider, message: "unused in this test" })),
  });

const withToken = (
  token: string | null = "test-key",
  source: CredentialSource = "env",
  invalidated: Array<string> = [],
) => Effect.provide(clientLayer.pipe(Layer.provide(stubCredentials(token, source, invalidated))));

const teamBundle = {
  id: "team-uuid",
  key: "AUD",
  issues: {
    nodes: [
      {
        id: "issue-uuid",
        identifier: "AUD-1",
        title: "ship it",
        url: "https://linear.app/acme/issue/AUD-1",
        labels: { nodes: [{ name: "state:ready-for-agent" }] },
        assignee: { id: "assignee-user" },
        state: { name: "Todo", type: "unstarted" },
      },
    ],
  },
  states: { nodes: [{ id: "state-todo", name: "Todo", type: "unstarted" }] },
  labels: { nodes: [{ id: "label-uuid", name: "state:ready-for-agent" }] },
};

describe("linear client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.effect("reads a team addressed by its key with a single request", () =>
    Effect.gen(function* () {
      const fetchStub = stubLinear((document) =>
        document.includes("TeamsByKey")
          ? { body: { data: { teams: { nodes: [teamBundle] } } } }
          : { body: { errors: [{ message: `unexpected document: ${document}` }] } },
      );
      const client = yield* LinearClient;
      const issues = yield* client.observeIssues(ref, null);
      assert.deepStrictEqual(
        issues.map((issue) => [issue.identifier, issue.stateName]),
        [["AUD-1", "Todo"]],
      );
      assert.strictEqual(fetchStub.mock.calls.length, 1);
    }).pipe(withToken()),
  );

  it.effect("reads a team addressed by its uuid", () =>
    Effect.gen(function* () {
      const fetchStub = stubLinear((document) =>
        document.includes("TeamById")
          ? { body: { data: { team: teamBundle } } }
          : { body: { errors: [{ message: `unexpected document: ${document}` }] } },
      );
      const client = yield* LinearClient;
      const issues = yield* client.observeIssues(
        { ...ref, team: "8dcbf3d4-6c9e-4a11-9f2f-0f1a2b3c4d5e" },
        null,
      );
      assert.deepStrictEqual(
        issues.map((issue) => issue.identifier),
        ["AUD-1"],
      );
      assert.strictEqual(fetchStub.mock.calls.length, 1);
    }).pipe(withToken()),
  );

  it.effect("sends an API key as the bare Authorization value", () =>
    Effect.gen(function* () {
      const fetchStub = stubLinear(() => ({ body: { data: { teams: { nodes: [teamBundle] } } } }));
      const client = yield* LinearClient;
      yield* client.observeIssues(ref, null);
      assert.strictEqual(authorizationOf(fetchStub), "test-key");
    }).pipe(withToken("test-key", "env")),
  );

  it.effect("sends a stored OAuth token as a Bearer credential", () =>
    Effect.gen(function* () {
      const fetchStub = stubLinear(() => ({ body: { data: { teams: { nodes: [teamBundle] } } } }));
      const client = yield* LinearClient;
      yield* client.observeIssues(ref, null);
      assert.strictEqual(authorizationOf(fetchStub), "Bearer oauth-token");
    }).pipe(withToken("oauth-token", "stored-oauth")),
  );

  it.effect("sends a client-credentials token as a Bearer credential", () =>
    Effect.gen(function* () {
      const fetchStub = stubLinear(() => ({ body: { data: { teams: { nodes: [teamBundle] } } } }));
      const client = yield* LinearClient;
      yield* client.observeIssues(ref, null);
      assert.strictEqual(authorizationOf(fetchStub), "Bearer app-token");
    }).pipe(withToken("app-token", "client-credentials")),
  );

  it.effect("reads every issue's coordination comments in the same request as the issue list", () =>
    Effect.gen(function* () {
      const backlog = Array.from({ length: 100 }, (_, index) => ({
        ...(teamBundle.issues.nodes[0] ?? {}),
        id: `issue-${index}`,
        identifier: `AUD-${index + 1}`,
        comments: {
          nodes: [
            {
              id: `ledger-${index}`,
              body: "cogwork:ledger",
              createdAt: "2026-07-31T00:00:00.000Z",
              user: { id: "bot-user" },
            },
          ],
        },
      }));
      const fetchStub = stubLinear(() => ({
        body: { data: { teams: { nodes: [{ ...teamBundle, issues: { nodes: backlog } }] } } },
      }));
      const client = yield* LinearClient;
      const issues = yield* client.observeIssues(ref, {
        actorUserId: "bot-user",
        ledgerMarker: "cogwork:ledger",
        proposalMarker: "generated by AI during triage",
      });
      assert.strictEqual(issues.length, 100);
      assert.deepStrictEqual(issues[0]?.assignees, ["assignee-user"]);
      assert.deepStrictEqual(
        issues[0]?.coordinationComments.map((comment) => comment.authorId),
        ["bot-user"],
      );
      assert.strictEqual(fetchStub.mock.calls.length, 1);
      const [request] = sentRequests(fetchStub);
      assert.include(request?.query ?? "", "comments(");
      assert.include(request?.query ?? "", "proposalComments:");
      assert.deepStrictEqual(request?.variables, {
        key: "AUD",
        bot: "bot-user",
        ledger: "cogwork:ledger",
        proposal: "generated by AI during triage",
      });
    }).pipe(withToken()),
  );

  it.effect("keeps the nested observe query under Linear's single-query complexity cap", () =>
    Effect.gen(function* () {
      const fetchStub = stubLinear(() => ({ body: { data: { teams: { nodes: [teamBundle] } } } }));
      const client = yield* LinearClient;
      yield* client.observeIssues(ref, {
        actorUserId: "bot-user",
        ledgerMarker: "cogwork:ledger",
        proposalMarker: "generated by AI during triage",
      });
      const [request] = sentRequests(fetchStub);
      const document = request?.query ?? "";
      assert.deepStrictEqual(
        connectionsOf(document)
          .map((connection) => connection.name)
          .toSorted(),
        ["comments", "inverseRelations", "issues", "labels", "proposalComments", "teams"],
      );
      assert.isAtMost(complexityOf(document), linearMaxQueryComplexity);
    }).pipe(withToken()),
  );

  it.effect("counts open blocking relations across open states, ignoring resolved and non-blocks", () =>
    Effect.gen(function* () {
      const withRelations = {
        ...teamBundle.issues.nodes[0],
        inverseRelations: {
          nodes: [
            { type: "blocks", issue: { state: { type: "started" } } },
            { type: "blocks", issue: { state: { type: "unstarted" } } },
            { type: "blocks", issue: { state: { type: "backlog" } } },
            { type: "blocks", issue: { state: { type: "completed" } } },
            { type: "blocks", issue: { state: { type: "canceled" } } },
            { type: "related", issue: { state: { type: "unstarted" } } },
          ],
        },
      };
      stubLinear(() => ({
        body: { data: { teams: { nodes: [{ ...teamBundle, issues: { nodes: [withRelations] } }] } } },
      }));
      const client = yield* LinearClient;
      const issues = yield* client.observeIssues(ref, null);
      assert.strictEqual(issues[0]?.openBlockers, 3);
    }).pipe(withToken()),
  );

  it.effect("treats an issue with no blocking relations as unblocked", () =>
    Effect.gen(function* () {
      stubLinear(() => ({ body: { data: { teams: { nodes: [teamBundle] } } } }));
      const client = yield* LinearClient;
      const issues = yield* client.observeIssues(ref, null);
      assert.strictEqual(issues[0]?.openBlockers, 0);
    }).pipe(withToken()),
  );

  it.effect("holds an issue whose relation page is full even when every visible blocker is resolved", () =>
    Effect.gen(function* () {
      const fullPage = Array.from({ length: 8 }, () => ({
        type: "blocks",
        issue: { state: { type: "completed" } },
      }));
      const withRelations = { ...teamBundle.issues.nodes[0], inverseRelations: { nodes: fullPage } };
      stubLinear(() => ({
        body: { data: { teams: { nodes: [{ ...teamBundle, issues: { nodes: [withRelations] } }] } } },
      }));
      const client = yield* LinearClient;
      const issues = yield* client.observeIssues(ref, null);
      assert.strictEqual(issues[0]?.openBlockers, 1);
    }).pipe(withToken()),
  );

  it.effect("omits the comment selection entirely when no bot user is configured", () =>
    Effect.gen(function* () {
      const fetchStub = stubLinear(() => ({ body: { data: { teams: { nodes: [teamBundle] } } } }));
      const client = yield* LinearClient;
      const issues = yield* client.observeIssues(ref, null);
      assert.deepStrictEqual(issues[0]?.coordinationComments, []);
      const [request] = sentRequests(fetchStub);
      assert.notInclude(request?.query ?? "", "comments(");
    }).pipe(withToken()),
  );

  it.effect("skips comments Linear reports without an author", () =>
    Effect.gen(function* () {
      stubLinear(() => ({
        body: {
          data: {
            issue: {
              comments: {
                nodes: [
                  {
                    id: "c1",
                    body: "from a person",
                    createdAt: "2026-07-31T00:00:00.000Z",
                    user: { id: "u1" },
                  },
                  {
                    id: "c2",
                    body: "from an integration",
                    createdAt: "2026-07-31T00:00:01.000Z",
                    user: null,
                  },
                ],
              },
            },
          },
        },
      }));
      const client = yield* LinearClient;
      const comments = yield* client.listComments(ref, "AUD-1");
      assert.deepStrictEqual(
        comments.map((comment) => [comment.id, comment.authorId]),
        [["c1", "u1"]],
      );
    }).pipe(withToken()),
  );

  it.effect("reports an unauthorized response as reason auth", () =>
    Effect.gen(function* () {
      stubLinear(() => ({ status: 401, body: {} }));
      const client = yield* LinearClient;
      const error = yield* Effect.flip(client.observeIssues(ref, null));
      assert.strictEqual(error.reason, "auth");
    }).pipe(withToken()),
  );

  it.effect("tells the store to drop the credential Linear rejected", () => {
    const invalidated: Array<string> = [];
    return Effect.gen(function* () {
      stubLinear(() => ({ status: 401, body: {} }));
      const client = yield* LinearClient;
      yield* Effect.flip(client.observeIssues(ref, null));
      assert.deepStrictEqual(invalidated, ["AUD"]);
    }).pipe(withToken("app-token", "client-credentials", invalidated));
  });

  it.effect("keeps the credential when Linear throttles rather than rejects", () => {
    const invalidated: Array<string> = [];
    return Effect.gen(function* () {
      stubLinear(() => ({ status: 429, body: {} }));
      const client = yield* LinearClient;
      yield* Effect.flip(client.observeIssues(ref, null));
      assert.deepStrictEqual(invalidated, []);
    }).pipe(withToken("app-token", "client-credentials", invalidated));
  });

  it.effect("retries a transient failure with backoff before reporting it unavailable", () =>
    Effect.gen(function* () {
      const fetchStub = stubLinear(() => ({ status: 500, body: {} }));
      const client = yield* LinearClient;
      const failure = yield* Effect.forkChild(Effect.flip(client.observeIssues(ref, null)));
      yield* TestClock.adjust("1 minute");
      const error = yield* Fiber.join(failure);
      assert.strictEqual(error.reason, "unavailable");
      assert.strictEqual(fetchStub.mock.calls.length, 4);
    }).pipe(withToken()),
  );

  it.effect("does not retry an auth failure", () =>
    Effect.gen(function* () {
      const fetchStub = stubLinear(() => ({ status: 401, body: {} }));
      const client = yield* LinearClient;
      yield* Effect.flip(client.observeIssues(ref, null));
      assert.strictEqual(fetchStub.mock.calls.length, 1);
    }).pipe(withToken()),
  );

  it.effect("reports a throttled response as reason rate-limited", () =>
    Effect.gen(function* () {
      stubLinear(() => ({ status: 429, body: {} }));
      const client = yield* LinearClient;
      const error = yield* Effect.flip(client.observeIssues(ref, null));
      assert.strictEqual(error.reason, "rate-limited");
    }).pipe(withToken()),
  );

  it.effect("carries the SDK's retry-after seconds onto the work source error", () =>
    Effect.gen(function* () {
      stubLinear(() => ({ status: 429, body: {}, headers: { "retry-after": "42" } }));
      const client = yield* LinearClient;
      const error = yield* Effect.flip(client.observeIssues(ref, null));
      assert.strictEqual(error.retryAfterMillis, 42_000);
    }).pipe(withToken()),
  );

  it.effect("falls back to the requests-reset instant when there is no retry-after", () =>
    Effect.gen(function* () {
      const nowMillis = yield* Clock.currentTimeMillis;
      stubLinear(() => ({
        status: 429,
        body: {},
        headers: { "x-ratelimit-requests-reset": String(nowMillis + 90_000) },
      }));
      const client = yield* LinearClient;
      const error = yield* Effect.flip(client.observeIssues(ref, null));
      assert.strictEqual(error.retryAfterMillis, 90_000);
    }).pipe(withToken()),
  );

  it.effect("fails fast without calling Linear while the credential is in a cooldown window", () =>
    Effect.gen(function* () {
      const fetchStub = stubLinear(() => ({ status: 429, body: {}, headers: { "retry-after": "30" } }));
      const client = yield* LinearClient;
      yield* Effect.flip(client.observeIssues(ref, null));
      assert.strictEqual(fetchStub.mock.calls.length, 1);

      const blocked = yield* Effect.flip(client.observeIssues({ ...ref, team: "OPS" }, null));
      assert.strictEqual(blocked.reason, "rate-limited");
      assert.strictEqual(fetchStub.mock.calls.length, 1);

      yield* TestClock.adjust("31 seconds");
      yield* Effect.flip(client.observeIssues(ref, null));
      assert.strictEqual(fetchStub.mock.calls.length, 2);
    }).pipe(withToken()),
  );

  it.effect("reports an unresolvable credential as reason auth without calling Linear", () =>
    Effect.gen(function* () {
      const fetchStub = stubLinear(() => ({ body: {} }));
      const client = yield* LinearClient;
      const error = yield* Effect.flip(client.observeIssues(ref, null));
      assert.strictEqual(error.reason, "auth");
      assert.include(error.message, "LINEAR_API_KEY");
      assert.strictEqual(fetchStub.mock.calls.length, 0);
    }).pipe(withToken(null)),
  );

  it.effect("fails when a mutation reports no success", () =>
    Effect.gen(function* () {
      stubLinear(() => ({ body: { data: { commentCreate: { success: false } } } }));
      const client = yield* LinearClient;
      const error = yield* Effect.flip(client.createComment(ref, "AUD-1", "body"));
      assert.strictEqual(error.reason, "unavailable");
      assert.include(error.message, "commentCreate");
    }).pipe(withToken()),
  );
});
