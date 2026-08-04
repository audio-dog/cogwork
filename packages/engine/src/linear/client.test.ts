import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { afterEach, vi } from "vitest";
import { CredentialError, type CredentialSource, CredentialStore } from "../CredentialStore";
import { layer as clientLayer, LinearClient, type LinearTeamRef } from "./client";

const ref: LinearTeamRef = {
  team: "AUD",
  tokenEnv: "LINEAR_API_KEY",
  organization: null,
  clientId: null,
};

interface StubResponse {
  readonly status?: number;
  readonly body: unknown;
}

const documentOf = (init: RequestInit | undefined) => {
  const body = init?.body;
  if (typeof body !== "string") return "";
  const parsed: { readonly query?: string } = JSON.parse(body);
  return parsed.query ?? "";
};

const stubLinear = (route: (document: string) => StubResponse) => {
  const fetchStub = vi.fn((_input: unknown, init?: RequestInit) => {
    const { status = 200, body } = route(documentOf(init));
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  });
  vi.stubGlobal("fetch", fetchStub);
  return fetchStub;
};

const authorizationOf = (fetchStub: { readonly mock: { readonly calls: ReadonlyArray<unknown> } }) => {
  const [, init] = (fetchStub.mock.calls[0] ?? []) as [unknown, RequestInit | undefined];
  return new Headers(init?.headers).get("authorization");
};

const stubCredentials = (token: string | null, source: CredentialSource = "env") =>
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
  });

const withToken = (token: string | null = "test-key", source: CredentialSource = "env") =>
  Effect.provide(clientLayer.pipe(Layer.provide(stubCredentials(token, source))));

const teamBundle = {
  id: "team-uuid",
  key: "AUD",
  issues: {
    nodes: [
      {
        id: "issue-uuid",
        identifier: "AUD-1",
        title: "ship it",
        labels: { nodes: [{ name: "state:ready-for-agent" }] },
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
      const issues = yield* client.listIssues(ref);
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
      const issues = yield* client.listIssues({ ...ref, team: "8dcbf3d4-6c9e-4a11-9f2f-0f1a2b3c4d5e" });
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
      yield* client.listIssues(ref);
      assert.strictEqual(authorizationOf(fetchStub), "test-key");
    }).pipe(withToken("test-key", "env")),
  );

  it.effect("sends a stored OAuth token as a Bearer credential", () =>
    Effect.gen(function* () {
      const fetchStub = stubLinear(() => ({ body: { data: { teams: { nodes: [teamBundle] } } } }));
      const client = yield* LinearClient;
      yield* client.listIssues(ref);
      assert.strictEqual(authorizationOf(fetchStub), "Bearer oauth-token");
    }).pipe(withToken("oauth-token", "stored-oauth")),
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
      const error = yield* Effect.flip(client.listIssues(ref));
      assert.strictEqual(error.reason, "auth");
    }).pipe(withToken()),
  );

  it.effect("reports a non-credential client error as reason unavailable", () =>
    Effect.gen(function* () {
      stubLinear(() => ({ status: 404, body: {} }));
      const client = yield* LinearClient;
      const error = yield* Effect.flip(client.listIssues(ref));
      assert.strictEqual(error.reason, "unavailable");
    }).pipe(withToken()),
  );

  it.effect("reports a throttled response as reason rate-limited", () =>
    Effect.gen(function* () {
      stubLinear(() => ({ status: 429, body: {} }));
      const client = yield* LinearClient;
      const error = yield* Effect.flip(client.listIssues(ref));
      assert.strictEqual(error.reason, "rate-limited");
    }).pipe(withToken()),
  );

  it.effect("reports an unresolvable credential as reason auth without calling Linear", () =>
    Effect.gen(function* () {
      const fetchStub = stubLinear(() => ({ body: {} }));
      const client = yield* LinearClient;
      const error = yield* Effect.flip(client.listIssues(ref));
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
