import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { afterEach, vi } from "vitest";
import { type CredentialAccount, CredentialStore } from "../credential-store";
import { LinearClient, layer } from "./client";

const account: CredentialAccount = {
  key: "AUD",
  issueTracker: "linear",
  organization: null,
  tokenEnv: "LINEAR_API_KEY",
  clientCredentials: null,
  oauthClientId: null,
};

const credentials = Layer.mock(CredentialStore, {
  bearerToken: () => Effect.succeed({ source: "env", token: Redacted.make("lin_api_test"), identity: null }),
});

interface HistoryEntry {
  readonly createdAt: string;
  readonly addedLabels: ReadonlyArray<{ readonly name: string }> | null;
}

const stubHistory = (nodes: ReadonlyArray<HistoryEntry>) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: { issue: { history: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    ),
  );

describe("Linear label history", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.effect("finds when a label was applied among history entries that added no labels", () =>
    Effect.gen(function* () {
      stubHistory([
        { createdAt: "2026-11-17T23:52:41.102Z", addedLabels: null },
        { createdAt: "2026-11-17T23:52:51.256Z", addedLabels: [{ name: "needs-triage" }] },
        { createdAt: "2026-11-17T23:53:02.000Z", addedLabels: null },
      ]);
      const client = yield* LinearClient;

      const appliedAt = yield* client.labelAppliedAt({ team: "AUD", account }, "AUD-7", "needs-triage");

      assert.strictEqual(appliedAt, Date.parse("2026-11-17T23:52:51.256Z"));
    }).pipe(Effect.provide(layer.pipe(Layer.provide(credentials)))),
  );
});
