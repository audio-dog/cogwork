import { issueTrackerErrorIsPermanent } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import { TestClock } from "effect/testing";
import { afterEach, vi } from "vitest";
import {
  CredentialError,
  type CredentialIdentity,
  type CredentialSource,
  CredentialStore,
} from "../credential-store";
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
const propertiesPerIssue = 8;
const objectsPerIssue = 2;
const propertiesPerCoordinationComment = 4;
const propertiesPerRelation = 2;
const objectsPerRelation = 2;
const pageInfoPoints = objectPoints + 2 * propertyPoints;
const nestedRelationPageSize = 7;

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
    objectsPerIssue * objectPoints +
    connectionPoints(sizeOf("labels"), propertyPoints) +
    connectionPoints(sizeOf("comments"), commentPoints) +
    connectionPoints(sizeOf("proposalComments"), commentPoints) +
    connectionPoints(sizeOf("inverseRelations"), relationPoints) +
    pageInfoPoints;
  const teamPoints = connectionPoints(sizeOf("issues"), issuePoints) + pageInfoPoints;
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

const stubLinear = (route: (document: string, variables: Record<string, unknown>) => StubResponse) => {
  const fetchStub = vi.fn((_input: unknown, init?: RequestInit) => {
    const request = requestOf(init);
    const { status = 200, body, headers = {} } = route(request.query, request.variables);
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

class CredentialInvalidations extends Context.Service<
  CredentialInvalidations,
  Ref.Ref<ReadonlyArray<string>>
>()("@cogwork/engine/linear/client.test/CredentialInvalidations") {
  static readonly layer = Layer.effect(CredentialInvalidations, Ref.make<ReadonlyArray<string>>([]));
}

const stubCredentials = (
  credential: {
    readonly token: string;
    readonly source: CredentialSource;
    readonly identity: CredentialIdentity | null;
  } | null,
) =>
  Layer.effect(
    CredentialStore,
    Effect.map(CredentialInvalidations, (invalidated) => ({
      resolveSource: () => Effect.die("unexpected credential source resolution"),
      bearerToken: (account) =>
        credential === null
          ? Effect.fail(
              new CredentialError({
                account: account.key,
                message: `no credential for ${account.key}: ${account.tokenEnv} is unset or empty`,
                retryable: false,
              }),
            )
          : Effect.succeed({ ...credential, token: Redacted.make(credential.token) }),
      persist: () => Effect.void,
      invalidate: (account) => Ref.update(invalidated, (accounts) => [...accounts, account.key]),
      providerKey: (account) =>
        Effect.fail(
          new CredentialError({
            account: account.provider,
            message: "unused in this test",
            retryable: false,
          }),
        ),
      persistProviderKey: (key) =>
        Effect.fail(
          new CredentialError({ account: key.provider, message: "unused in this test", retryable: false }),
        ),
      configureConnection: () => Effect.void,
      removeConnection: () => Effect.void,
    })),
  ).pipe(Layer.provideMerge(CredentialInvalidations.layer));

const withToken = (token: string | null = "test-key", source: CredentialSource = "env") =>
  Effect.provide(
    clientLayer.pipe(
      Layer.provideMerge(stubCredentials(token === null ? null : { token, source, identity: null })),
    ),
  );

const claimLabelName = "cogwork:claimed";

const lastPage = { hasNextPage: false, endCursor: null };

const teamBundle = {
  id: "team-uuid",
  key: "AUD",
  issues: {
    pageInfo: lastPage,
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

const relationPage = (nodes: ReadonlyArray<unknown>, endCursor: string | null = null) => ({
  nodes,
  pageInfo: { hasNextPage: endCursor !== null, endCursor },
});

const issuesResponse = (inverseRelations: ReturnType<typeof relationPage>) => ({
  body: {
    data: {
      teams: {
        nodes: [
          {
            ...teamBundle,
            issues: {
              nodes: [{ ...teamBundle.issues.nodes[0], inverseRelations }],
              pageInfo: lastPage,
            },
          },
        ],
      },
    },
  },
});

const relationsResponse = (inverseRelations: ReturnType<typeof relationPage>) => ({
  body: { data: { issue: { inverseRelations } } },
});

const resolvedRelations = () =>
  Array.from({ length: nestedRelationPageSize }, () => ({
    type: "blocks",
    issue: { state: { type: "completed" } },
  }));

const relationRoute =
  (firstPage: ReturnType<typeof relationPage>, pages: Readonly<Record<string, StubResponse>>) =>
  (document: string, variables: Record<string, unknown>) =>
    document.includes("IssueInverseRelations")
      ? (pages[String(variables.after)] ?? {
          body: { errors: [{ message: `unexpected relation cursor: ${String(variables.after)}` }] },
        })
      : issuesResponse(firstPage);

describe("linear client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.effect("reads the authenticated user id for an API key", () => {
    const fetchStub = stubLinear(() => ({ body: { data: { viewer: { id: "api-user" } } } }));

    return Effect.gen(function* () {
      const client = yield* LinearClient;
      assert.strictEqual(yield* client.authenticatedUserId(ref), "api-user");
      assert.strictEqual(fetchStub.mock.calls.length, 1);
    }).pipe(withToken());
  });

  it.effect("reuses the stored OAuth identity without another request", () => {
    const fetchStub = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetchStub);

    return Effect.gen(function* () {
      const client = yield* LinearClient;
      assert.strictEqual(yield* client.authenticatedUserId(ref), "stored-user");
      assert.strictEqual(fetchStub.mock.calls.length, 0);
    }).pipe(
      Effect.provide(
        clientLayer.pipe(
          Layer.provideMerge(
            stubCredentials({
              token: "oauth-token",
              source: "stored-oauth",
              identity: { organization: "acme", actorUserId: "stored-user" },
            }),
          ),
        ),
      ),
    );
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

  it.effect("follows the issues cursor until the backlog is exhausted", () =>
    Effect.gen(function* () {
      const pageOf = (nodes: ReadonlyArray<unknown>, endCursor: string | null) => ({
        body: {
          data: {
            teams: {
              nodes: [
                {
                  ...teamBundle,
                  issues: { nodes, pageInfo: { hasNextPage: endCursor !== null, endCursor } },
                },
              ],
            },
          },
        },
      });
      const olderIssue = { ...teamBundle.issues.nodes[0], id: "issue-old", identifier: "AUD-2" };
      const fetchStub = stubLinear((_document, variables) =>
        variables.after === null ? pageOf(teamBundle.issues.nodes, "cursor-1") : pageOf([olderIssue], null),
      );
      const client = yield* LinearClient;
      const issues = yield* client.observeIssues(ref, null);
      assert.deepStrictEqual(
        issues.map((issue) => issue.identifier),
        ["AUD-1", "AUD-2"],
      );
      assert.deepStrictEqual(
        sentRequests(fetchStub).map((request) => request.variables.after),
        [null, "cursor-1"],
      );
    }).pipe(withToken()),
  );

  it.effect("filters server-side to the assignee allowlist when one is configured", () =>
    Effect.gen(function* () {
      const fetchStub = stubLinear(() => ({ body: { data: { teams: { nodes: [teamBundle] } } } }));
      const client = yield* LinearClient;
      yield* client.observeIssues(ref, null, ["assignee-user"]);
      const [request] = sentRequests(fetchStub);
      assert.deepStrictEqual(request?.variables.filter, {
        state: { type: { nin: ["completed"] } },
        assignee: { id: { in: ["assignee-user"] } },
      });
    }).pipe(withToken()),
  );

  it.effect("leaves the assignee filter off when no allowlist is configured", () =>
    Effect.gen(function* () {
      const fetchStub = stubLinear(() => ({ body: { data: { teams: { nodes: [teamBundle] } } } }));
      const client = yield* LinearClient;
      yield* client.observeIssues(ref, null);
      const [request] = sentRequests(fetchStub);
      assert.deepStrictEqual(request?.variables.filter, { state: { type: { nin: ["completed"] } } });
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

  it.effect("sends a stored API key as the bare Authorization value", () =>
    Effect.gen(function* () {
      const fetchStub = stubLinear(() => ({ body: { data: { teams: { nodes: [teamBundle] } } } }));
      const client = yield* LinearClient;
      yield* client.observeIssues(ref, null);
      assert.strictEqual(authorizationOf(fetchStub), "stored-key");
    }).pipe(withToken("stored-key", "stored-key")),
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
        body: {
          data: { teams: { nodes: [{ ...teamBundle, issues: { nodes: backlog, pageInfo: lastPage } }] } },
        },
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
        filter: { state: { type: { nin: ["completed"] } } },
        after: null,
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
      assert.strictEqual(pageSizesOf(document).get("inverseRelations"), nestedRelationPageSize);
      assert.isAtMost(complexityOf(document), linearMaxQueryComplexity);
    }).pipe(withToken()),
  );

  it.effect("counts open blocking relations across open states, ignoring resolved and non-blocks", () =>
    Effect.gen(function* () {
      const firstPage = relationPage([
        { type: "blocks", issue: { state: { type: "started" } } },
        { type: "blocks", issue: { state: { type: "unstarted" } } },
        { type: "blocks", issue: { state: { type: "backlog" } } },
        { type: "blocks", issue: { state: { type: "completed" } } },
        { type: "blocks", issue: { state: { type: "canceled" } } },
        { type: "related", issue: { state: { type: "unstarted" } } },
      ]);
      const fetchStub = stubLinear(() => issuesResponse(firstPage));
      const client = yield* LinearClient;
      const issues = yield* client.observeIssues(ref, null);
      assert.strictEqual(issues[0]?.openBlockers, 3);
      assert.strictEqual(fetchStub.mock.calls.length, 1);
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

  it.effect("reports no blocker after exhausting a full page of resolved relations", () =>
    Effect.gen(function* () {
      const firstPage = relationPage(resolvedRelations(), "relation-cursor-1");
      const fetchStub = stubLinear((document) =>
        document.includes("IssueInverseRelations")
          ? relationsResponse(relationPage([]))
          : issuesResponse(firstPage),
      );
      const client = yield* LinearClient;
      const issues = yield* client.observeIssues(ref, null);
      assert.strictEqual(issues[0]?.openBlockers, 0);
      assert.deepStrictEqual(
        sentRequests(fetchStub).map((request) => request.variables),
        [
          { key: "AUD", filter: { state: { type: { nin: ["completed"] } } }, after: null },
          { id: "issue-uuid", after: "relation-cursor-1" },
        ],
      );
      assert.include(sentRequests(fetchStub)[1]?.query ?? "", "inverseRelations(first: 100");
    }).pipe(withToken()),
  );

  it.effect("counts every open blocker after the first relation page", () =>
    Effect.gen(function* () {
      const firstPage = Array.from({ length: nestedRelationPageSize }, () => ({
        type: "related",
        issue: { state: { type: "unstarted" } },
      }));
      const relationPages: Record<string, StubResponse> = {
        "relation-cursor-1": relationsResponse(
          relationPage([{ type: "blocks", issue: { state: { type: "completed" } } }], "relation-cursor-2"),
        ),
        "relation-cursor-2": relationsResponse(
          relationPage([
            { type: "blocks", issue: { state: { type: "started" } } },
            { type: "blocks", issue: { state: { type: "backlog" } } },
            { type: "blocks", issue: { state: { type: "completed" } } },
          ]),
        ),
      };
      const fetchStub = stubLinear(
        relationRoute(relationPage(firstPage, "relation-cursor-1"), relationPages),
      );
      const client = yield* LinearClient;
      const issues = yield* client.observeIssues(ref, null);
      assert.strictEqual(issues[0]?.openBlockers, 2);
      assert.deepStrictEqual(
        sentRequests(fetchStub).map((request) => request.variables.after),
        [null, "relation-cursor-1", "relation-cursor-2"],
      );
    }).pipe(withToken()),
  );

  it.effect("surfaces a failed follow-up relation read", () =>
    Effect.gen(function* () {
      const fetchStub = stubLinear((document) =>
        document.includes("IssueInverseRelations")
          ? { body: { errors: [{ message: "relation lookup failed" }] } }
          : issuesResponse(relationPage(resolvedRelations(), "relation-cursor-1")),
      );
      const client = yield* LinearClient;
      const error = yield* Effect.flip(client.observeIssues(ref, null));
      assert.strictEqual(error.reason, "unavailable");
      assert.include(error.message, "relation lookup failed");
      assert.strictEqual(fetchStub.mock.calls.length, 2);
    }).pipe(withToken()),
  );

  it.effect("fails when relation cursors cycle", () =>
    Effect.gen(function* () {
      const firstPage = relationPage([], "relation-cursor-1");
      const relationPages: Record<string, StubResponse> = {
        "relation-cursor-1": relationsResponse(relationPage([], "relation-cursor-2")),
        "relation-cursor-2": relationsResponse(relationPage([], "relation-cursor-1")),
      };
      const fetchStub = stubLinear(relationRoute(firstPage, relationPages));
      const client = yield* LinearClient;
      const error = yield* Effect.flip(client.observeIssues(ref, null));
      assert.strictEqual(error.reason, "unavailable");
      assert.include(error.message, "cursor did not advance");
      assert.strictEqual(fetchStub.mock.calls.length, 3);
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

  it.effect("preserves comments Linear reports without an author", () =>
    Effect.gen(function* () {
      stubLinear(() => ({
        body: {
          data: {
            issue: {
              description: "Current issue body",
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
                pageInfo: lastPage,
              },
            },
          },
        },
      }));
      const client = yield* LinearClient;
      const comments = yield* client.listComments(ref, "AUD-1");
      assert.deepStrictEqual(
        comments.map((comment) => [comment.id, comment.authorId]),
        [
          ["c1", "u1"],
          ["c2", null],
        ],
      );
    }).pipe(withToken()),
  );

  it.effect("reads the current issue body and every comment page in order", () =>
    Effect.gen(function* () {
      const page = (id: string, endCursor: string | null) => ({
        body: {
          data: {
            issue: {
              description: "Current issue body",
              comments: {
                nodes: [
                  {
                    id,
                    body: id,
                    createdAt: "2026-07-31T00:00:00.000Z",
                    user: { id: `author-${id}` },
                  },
                ],
                pageInfo: { hasNextPage: endCursor !== null, endCursor },
              },
            },
          },
        },
      });
      const fetchStub = stubLinear((_document, variables) =>
        variables.after === null ? page("c1", "comment-cursor-1") : page("c2", null),
      );
      const client = yield* LinearClient;
      const prose = yield* client.readProse(ref, "AUD-1");
      assert.strictEqual(prose.body, "Current issue body");
      assert.deepStrictEqual(
        prose.comments.map(({ id }) => id),
        ["c1", "c2"],
      );
      assert.deepStrictEqual(
        sentRequests(fetchStub).map(({ variables }) => variables.after),
        [null, "comment-cursor-1"],
      );
    }).pipe(withToken()),
  );

  it.effect("fails when a continued comment page omits its cursor", () =>
    Effect.gen(function* () {
      stubLinear(() => ({
        body: {
          data: {
            issue: {
              description: "body",
              comments: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } },
            },
          },
        },
      }));
      const client = yield* LinearClient;
      const error = yield* Effect.flip(client.readProse(ref, "AUD-1"));
      assert.include(error.message, "comment page missing cursor");
    }).pipe(withToken()),
  );

  it.effect("fails when a comment cursor repeats", () =>
    Effect.gen(function* () {
      const fetchStub = stubLinear(() => ({
        body: {
          data: {
            issue: {
              description: "body",
              comments: {
                nodes: [],
                pageInfo: { hasNextPage: true, endCursor: "comment-cursor-1" },
              },
            },
          },
        },
      }));
      const client = yield* LinearClient;
      const error = yield* Effect.flip(client.readProse(ref, "AUD-1"));
      assert.include(error.message, "comment cursor did not advance");
      assert.strictEqual(fetchStub.mock.calls.length, 2);
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

  it.effect("tells the store to drop the credential Linear rejected", () =>
    Effect.gen(function* () {
      const invalidated = yield* CredentialInvalidations;
      stubLinear(() => ({ status: 401, body: {} }));
      const client = yield* LinearClient;
      yield* Effect.flip(client.observeIssues(ref, null));
      assert.deepStrictEqual(yield* Ref.get(invalidated), ["AUD"]);
    }).pipe(withToken("app-token", "client-credentials")),
  );

  it.effect("keeps the credential when Linear denies access to a resource", () =>
    Effect.gen(function* () {
      const invalidated = yield* CredentialInvalidations;
      stubLinear(() => ({
        body: { errors: [{ message: "access denied", extensions: { type: "forbidden" } }] },
      }));
      const client = yield* LinearClient;
      const error = yield* Effect.flip(client.observeIssues(ref, null));
      assert.strictEqual(error.reason, "unavailable");
      assert.deepStrictEqual(yield* Ref.get(invalidated), []);
    }).pipe(withToken("app-token", "client-credentials")),
  );

  it.effect("keeps the credential when Linear throttles rather than rejects", () =>
    Effect.gen(function* () {
      const invalidated = yield* CredentialInvalidations;
      stubLinear(() => ({ status: 429, body: {} }));
      const client = yield* LinearClient;
      yield* Effect.flip(client.observeIssues(ref, null));
      assert.deepStrictEqual(yield* Ref.get(invalidated), []);
    }).pipe(withToken("app-token", "client-credentials")),
  );

  it.effect("retries after a hanging attempt reaches its deadline", () =>
    Effect.gen(function* () {
      const fetchStub = stubLinear((document) =>
        document.includes("TeamsByKey")
          ? { body: { data: { teams: { nodes: [teamBundle] } } } }
          : { body: { errors: [{ message: `unexpected document: ${document}` }] } },
      );
      const onAbort = vi.fn();
      fetchStub.mockImplementationOnce((_input, init) => {
        init?.signal?.addEventListener("abort", onAbort);
        return Promise.withResolvers<Response>().promise;
      });
      const client = yield* LinearClient;
      const requestFiber = yield* Effect.forkChild(client.observeIssues(ref, null));
      yield* TestClock.adjust("1 minute");
      const issues = yield* Fiber.join(requestFiber);
      assert.deepStrictEqual(
        issues.map((issue) => issue.identifier),
        ["AUD-1"],
      );
      assert.strictEqual(fetchStub.mock.calls.length, 2);
      assert.strictEqual(onAbort.mock.calls.length, 1);
    }).pipe(withToken()),
  );

  it.effect("retries a rejected transport request", () =>
    Effect.gen(function* () {
      const fetchStub = stubLinear((document) =>
        document.includes("TeamsByKey")
          ? { body: { data: { teams: { nodes: [teamBundle] } } } }
          : { body: { errors: [{ message: `unexpected document: ${document}` }] } },
      );
      fetchStub.mockRejectedValueOnce(new TypeError("fetch failed"));
      const client = yield* LinearClient;
      const requestFiber = yield* Effect.forkChild(client.observeIssues(ref, null));
      yield* TestClock.adjust("5 seconds");
      const issues = yield* Fiber.join(requestFiber);
      assert.deepStrictEqual(
        issues.map((issue) => issue.identifier),
        ["AUD-1"],
      );
      assert.strictEqual(fetchStub.mock.calls.length, 2);
    }).pipe(withToken()),
  );

  it.effect("retries a mutation after a hanging attempt reaches its deadline", () =>
    Effect.gen(function* () {
      const fetchStub = stubLinear(() => ({ body: { data: { commentCreate: { success: true } } } }));
      const onAbort = vi.fn();
      fetchStub.mockImplementationOnce((_input, init) => {
        init?.signal?.addEventListener("abort", onAbort);
        return Promise.withResolvers<Response>().promise;
      });
      const client = yield* LinearClient;
      const requestFiber = yield* Effect.forkChild(client.createComment(ref, "AUD-1", "body"));
      yield* TestClock.adjust("1 minute");
      yield* Fiber.join(requestFiber);
      assert.strictEqual(fetchStub.mock.calls.length, 2);
      assert.strictEqual(onAbort.mock.calls.length, 1);
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

  it.effect("does not retry an invalid input failure", () =>
    Effect.gen(function* () {
      const fetchStub = stubLinear(() => ({
        body: {
          errors: [{ message: "invalid comment", extensions: { type: "invalid input", userError: true } }],
        },
      }));
      const client = yield* LinearClient;
      const error = yield* Effect.flip(client.createComment(ref, "AUD-1", "body"));
      assert.strictEqual(error.reason, "unavailable");
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

  it.effect("measures a rate-limit reset from the attempt that received it", () =>
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis;
      const fetchStub = stubLinear(() => ({
        status: 429,
        body: {},
        headers: { "x-ratelimit-requests-reset": String(startedAt + 90_000) },
      }));
      fetchStub.mockImplementationOnce(() => Promise.withResolvers<Response>().promise);
      const client = yield* LinearClient;
      const requestFiber = yield* Effect.forkChild(Effect.flip(client.observeIssues(ref, null)));
      yield* TestClock.adjust("31 seconds");
      const error = yield* Fiber.join(requestFiber);
      assert.isAtMost(error.retryAfterMillis ?? Number.POSITIVE_INFINITY, 60_000);
    }).pipe(withToken()),
  );

  it.effect("rechecks a shared rate-limit cooldown before retrying", () =>
    Effect.gen(function* () {
      const fetchStub = stubLinear(() => ({ status: 429, body: {} }));
      fetchStub.mockImplementationOnce(() => Promise.withResolvers<Response>().promise);
      const client = yield* LinearClient;
      const requestFiber = yield* Effect.forkChild(Effect.flip(client.observeIssues(ref, null)));
      yield* Effect.yieldNow;
      yield* Effect.flip(client.observeIssues(ref, null));
      yield* TestClock.adjust("31 seconds");
      const error = yield* Fiber.join(requestFiber);
      assert.strictEqual(error.reason, "rate-limited");
      assert.strictEqual(fetchStub.mock.calls.length, 2);
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

  it.effect("resolves a team label by name rather than paging the team's labels", () =>
    Effect.gen(function* () {
      const fetchStub = stubLinear((document) => {
        if (document.includes("TeamsByKey")) {
          return {
            body: {
              data: {
                teams: {
                  nodes: [
                    { id: "team-uuid", labels: { nodes: [{ id: "claim-uuid", name: claimLabelName }] } },
                  ],
                },
              },
            },
          };
        }
        if (document.includes("issueAddLabel")) {
          return { body: { data: { issueAddLabel: { success: true } } } };
        }
        return { body: { errors: [{ message: `unexpected document: ${document}` }] } };
      });
      const client = yield* LinearClient;
      yield* client.addLabel(ref, "issue-uuid", claimLabelName);
      const documents = sentRequests(fetchStub);
      const lookup = documents[0];
      assert.include(lookup?.query ?? "", "labels(filter: { name: { eq: $label } }, first: 1)");
      assert.strictEqual(lookup?.variables.label, claimLabelName);
      assert.isFalse(documents.some((request) => request.query.includes("issueLabelCreate")));
    }).pipe(withToken()),
  );

  it.effect("resolves a workspace-level label that no team lists", () =>
    Effect.gen(function* () {
      const fetchStub = stubLinear((document) => {
        if (document.includes("TeamsByKey")) {
          return { body: { data: { teams: { nodes: [{ id: "team-uuid", labels: { nodes: [] } }] } } } };
        }
        if (document.includes("WorkspaceLabelByName")) {
          return {
            body: {
              data: { issueLabels: { nodes: [{ id: "workspace-label-uuid", name: claimLabelName }] } },
            },
          };
        }
        if (document.includes("issueAddLabel")) {
          return { body: { data: { issueAddLabel: { success: true } } } };
        }
        return { body: { errors: [{ message: `unexpected document: ${document}` }] } };
      });
      const client = yield* LinearClient;
      yield* client.addLabel(ref, "issue-uuid", claimLabelName);
      const documents = sentRequests(fetchStub);
      assert.isTrue(documents.some((request) => request.query.includes("WorkspaceLabelByName")));
      assert.isFalse(documents.some((request) => request.query.includes("issueLabelCreate")));
      assert.strictEqual(
        documents.find((request) => request.query.includes("issueAddLabel"))?.variables.labelId,
        "workspace-label-uuid",
      );
    }).pipe(withToken()),
  );

  it.effect("marks a refused label create permanent and does not retry it", () =>
    Effect.gen(function* () {
      const fetchStub = stubLinear((document) => {
        if (document.includes("TeamsByKey")) {
          return { body: { data: { teams: { nodes: [{ id: "team-uuid", labels: { nodes: [] } }] } } } };
        }
        if (document.includes("WorkspaceLabelByName")) {
          return { body: { data: { issueLabels: { nodes: [] } } } };
        }
        return {
          body: {
            errors: [
              {
                message: "Not allowed to take action - You are not allowed to create labels in this team.",
                extensions: { type: "forbidden" },
              },
            ],
          },
        };
      });
      const client = yield* LinearClient;
      const error = yield* Effect.flip(client.addLabel(ref, "issue-uuid", claimLabelName));
      assert.strictEqual(error.retryable, false);
      assert.strictEqual(error.reason, "unavailable");
      assert.strictEqual(
        sentRequests(fetchStub).filter((request) => request.query.includes("issueLabelCreate")).length,
        1,
      );
    }).pipe(withToken()),
  );

  it.effect("treats an untyped refusal to create a label as permanent, without retrying it", () =>
    Effect.gen(function* () {
      const fetchStub = stubLinear((document) => {
        if (document.includes("TeamsByKey")) {
          return { body: { data: { teams: { nodes: [{ id: "team-uuid", labels: { nodes: [] } }] } } } };
        }
        if (document.includes("WorkspaceLabelByName")) {
          return { body: { data: { issueLabels: { nodes: [] } } } };
        }
        return {
          body: {
            errors: [
              { message: "Not allowed to take action - You are not allowed to create labels in this team." },
            ],
          },
        };
      });
      const client = yield* LinearClient;
      const error = yield* Effect.flip(client.addLabel(ref, "issue-uuid", claimLabelName));
      assert.include(error.message, claimLabelName);
      assert.include(error.message, "AUD");
      assert.include(error.message, "not allowed to create labels");
      assert.isTrue(issueTrackerErrorIsPermanent(error));
      assert.strictEqual(
        sentRequests(fetchStub).filter((request) => request.query.includes("issueLabelCreate")).length,
        1,
      );
    }).pipe(withToken()),
  );

  it.effect("never reads a failed comment write as a permanent refusal", () =>
    Effect.gen(function* () {
      stubLinear(() => ({ body: { errors: [{ message: "Something went wrong" }] } }));
      const client = yield* LinearClient;
      const error = yield* Effect.flip(client.createComment(ref, "issue-uuid", "body"));
      assert.strictEqual(error.reason, "unavailable");
      assert.isFalse(issueTrackerErrorIsPermanent(error));
    }).pipe(withToken()),
  );

  it.effect("reads a forbidden write as a permanent refusal", () =>
    Effect.gen(function* () {
      stubLinear(() => ({
        body: {
          errors: [
            {
              message: "Not allowed to take action - You are not allowed to do this.",
              extensions: { type: "forbidden" },
            },
          ],
        },
      }));
      const client = yield* LinearClient;
      const error = yield* Effect.flip(client.createComment(ref, "issue-uuid", "body"));
      assert.isTrue(issueTrackerErrorIsPermanent(error));
    }).pipe(withToken()),
  );

  it.effect("never reads a rate-limited label create as a permanent refusal", () =>
    Effect.gen(function* () {
      stubLinear((document) => {
        if (document.includes("TeamsByKey")) {
          return { body: { data: { teams: { nodes: [{ id: "team-uuid", labels: { nodes: [] } }] } } } };
        }
        if (document.includes("WorkspaceLabelByName")) {
          return { body: { data: { issueLabels: { nodes: [] } } } };
        }
        return { status: 429, body: {} };
      });
      const client = yield* LinearClient;
      const error = yield* Effect.flip(client.addLabel(ref, "issue-uuid", claimLabelName));
      assert.strictEqual(error.reason, "rate-limited");
      assert.isFalse(issueTrackerErrorIsPermanent(error));
    }).pipe(withToken()),
  );

  it.effect("skips the remove when neither the team nor the workspace holds the label", () =>
    Effect.gen(function* () {
      const fetchStub = stubLinear((document) => {
        if (document.includes("TeamsByKey")) {
          return { body: { data: { teams: { nodes: [{ id: "team-uuid", labels: { nodes: [] } }] } } } };
        }
        if (document.includes("WorkspaceLabelByName")) {
          return { body: { data: { issueLabels: { nodes: [] } } } };
        }
        return { body: { errors: [{ message: `unexpected document: ${document}` }] } };
      });
      const client = yield* LinearClient;
      yield* client.removeLabel(ref, "issue-uuid", claimLabelName);
      assert.isFalse(sentRequests(fetchStub).some((request) => request.query.includes("issueRemoveLabel")));
    }).pipe(withToken()),
  );
});
