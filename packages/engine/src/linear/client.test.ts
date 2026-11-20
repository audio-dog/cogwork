import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { afterEach, vi } from "vitest";

import { type CredentialAccount, CredentialStore } from "../credential-store";
import { LinearClient, layer } from "./client";

const account: CredentialAccount = {
  key: "ENG",
  issueTracker: "linear",
  organization: null,
  tokenEnv: "LINEAR_API_KEY",
  clientCredentials: null,
  oauthClientId: null,
};

const ref = { team: "ENG", account };

const credentials = Layer.mock(CredentialStore, {
  bearerToken: () => Effect.succeed({ source: "env", token: Redacted.make("lin_api_key"), identity: null }),
});

const graphqlResponse = (data: unknown) =>
  new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });

const usersPage = (nodes: ReadonlyArray<unknown>, endCursor: string | null) =>
  graphqlResponse({ users: { nodes, pageInfo: { hasNextPage: endCursor !== null, endCursor } } });

interface HistoryEntry {
  readonly createdAt: string;
  readonly addedLabels: ReadonlyArray<{ readonly name: string }> | null;
}

const stubHistory = (nodes: ReadonlyArray<HistoryEntry>) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        graphqlResponse({ issue: { history: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } }),
      ),
    ),
  );

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LinearClient.listActiveUsers", () => {
  it.effect("collects active users from every page", () => {
    const requests: Array<{ readonly query: string; readonly variables: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>((_input, init) => {
        const request = JSON.parse(String(init?.body));
        requests.push(request);
        return Promise.resolve(
          request.variables.after === "cursor-1"
            ? usersPage([{ id: "user-2", name: "Ada Lovelace", displayName: "ada" }], null)
            : usersPage([{ id: "user-1", name: "Taylor Steele", displayName: "taylor.steele" }], "cursor-1"),
        );
      }),
    );

    return Effect.gen(function* () {
      const users = yield* (yield* LinearClient).listActiveUsers(ref);

      assert.deepStrictEqual(
        users.map(({ id }) => id),
        ["user-1", "user-2"],
      );
      assert.include(requests[0]?.query, "active: { eq: true }");
    }).pipe(Effect.provide(layer.pipe(Layer.provide(credentials))));
  });
});

describe("Linear label history", () => {
  it.effect("finds when a label was applied among history entries that added no labels", () =>
    Effect.gen(function* () {
      stubHistory([
        { createdAt: "2026-11-17T23:52:41.102Z", addedLabels: null },
        { createdAt: "2026-11-17T23:52:51.256Z", addedLabels: [{ name: "needs-triage" }] },
        { createdAt: "2026-11-17T23:53:02.000Z", addedLabels: null },
      ]);
      const client = yield* LinearClient;

      const appliedAt = yield* client.labelAppliedAt(ref, "ENG-7", "needs-triage");

      assert.strictEqual(appliedAt, Date.parse("2026-11-17T23:52:51.256Z"));
    }).pipe(Effect.provide(layer.pipe(Layer.provide(credentials)))),
  );
});
