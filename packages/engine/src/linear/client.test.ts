import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { afterEach, vi } from "vitest";
import { CredentialStore } from "../credential-store";
import { layer as clientLayer, LinearClient } from "./client";

const ref = {
  team: "ENG",
  account: {
    key: "ENG",
    issueTracker: "linear",
    organization: null,
    tokenEnv: "LINEAR_API_KEY",
    clientCredentials: null,
    oauthClientId: null,
  },
};

const credentials = Layer.mock(CredentialStore, {
  bearerToken: () => Effect.succeed({ source: "env", token: Redacted.make("lin_api_key"), identity: null }),
});

const graphqlResponse = (data: unknown) =>
  new Response(JSON.stringify({ data }), { headers: { "content-type": "application/json" } });

const usersPage = (nodes: ReadonlyArray<unknown>, endCursor: string | null) =>
  graphqlResponse({ users: { nodes, pageInfo: { hasNextPage: endCursor !== null, endCursor } } });

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
    }).pipe(Effect.provide(clientLayer.pipe(Layer.provide(credentials))));
  });
});
