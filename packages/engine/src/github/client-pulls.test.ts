import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { vi } from "vitest";

import { layer as clientLayer, GitHubClient, type GitHubRepoRef } from "./client";

const repo: GitHubRepoRef = { owner: "colonylabs", name: "cogwork", tokenEnv: "GITHUB_TOKEN" };

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

const fetchLayer = (fetch: typeof globalThis.fetch) =>
  Layer.merge(
    clientLayer.pipe(
      Layer.provide(FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)))),
    ),
    ConfigProvider.layer(ConfigProvider.fromEnv({ env: { GITHUB_TOKEN: "test-token" } })),
  );

describe("GitHub pull request reads", () => {
  it.effect("reads the details URL, title, and summary of a check run", () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        jsonResponse({
          check_runs: [
            {
              name: "format-and-lint",
              status: "completed",
              conclusion: "failure",
              started_at: "2026-11-18T12:00:00Z",
              completed_at: "2026-11-18T12:01:00Z",
              details_url: "https://github.com/colonylabs/cogwork/actions/runs/1",
              output: { title: "1 lint error", summary: "noUnusedImports in src/index.ts" },
            },
          ],
        }),
      ),
    );

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      const [check] = yield* client.listCheckRuns(repo, "head-sha");

      assert.deepStrictEqual(
        [check?.detailsUrl, check?.outputTitle, check?.outputSummary],
        [
          "https://github.com/colonylabs/cogwork/actions/runs/1",
          "1 lint error",
          "noUnusedImports in src/index.ts",
        ],
      );
    }).pipe(Effect.provide(fetchLayer(fetch)));
  });

  it.effect("identifies a check run from GitHub Actions by its job id", () => {
    const run = {
      status: "completed",
      conclusion: "failure",
      started_at: "2026-11-18T12:00:00Z",
      completed_at: "2026-11-18T12:01:00Z",
    };
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        jsonResponse({
          check_runs: [
            { ...run, id: 136510915743, name: "test", app: { slug: "github-actions" } },
            { ...run, id: 42, name: "external-ci", app: { slug: "circleci-checks" } },
          ],
        }),
      ),
    );

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      const checks = yield* client.listCheckRuns(repo, "head-sha");

      assert.deepStrictEqual(
        checks.map(({ name, actionsJobId }) => [name, actionsJobId]),
        [
          ["test", 136510915743],
          ["external-ci", null],
        ],
      );
    }).pipe(Effect.provide(fetchLayer(fetch)));
  });

  it.effect("reads a GitHub Actions job log once and returns its failure excerpt", () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        new Response(
          [
            "2026-11-20T19:17:20.7817347Z  FAIL  src/index.test.ts > adds",
            "2026-11-20T19:17:20.7819334Z AssertionError: expected 3 to equal 4",
            "2026-11-20T19:17:21.2746667Z ##[error]Process completed with exit code 1.",
            "2026-11-20T19:17:22.2697674Z Cleaning up orphan processes",
          ].join("\n"),
          { status: 200, headers: { "content-type": "text/plain" } },
        ),
      ),
    );

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      const first = yield* client.getActionsJobLogExcerpt(repo, 136510915743);
      const second = yield* client.getActionsJobLogExcerpt(repo, 136510915743);

      assert.strictEqual(
        first,
        " FAIL  src/index.test.ts > adds\nAssertionError: expected 3 to equal 4\n##[error]Process completed with exit code 1.",
      );
      assert.strictEqual(second, first);
      assert.deepStrictEqual(
        fetch.mock.calls.map(([input]) => String(input)),
        ["https://api.github.com/repos/colonylabs/cogwork/actions/jobs/136510915743/logs"],
      );
    }).pipe(Effect.provide(fetchLayer(fetch)));
  });

  it.effect("reads the mergeable state and description of a pull request", () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        jsonResponse({
          number: 480,
          title: "Review this change",
          body: "Please review the implementation.",
          user: { login: "cogwork[bot]" },
          head: { sha: "head-sha", ref: "480-work-item" },
          base: { sha: "base-sha", ref: "main" },
          mergeable_state: "dirty",
        }),
      ),
    );

    return Effect.gen(function* () {
      const client = yield* GitHubClient;
      const pull = yield* client.getPull(repo, 480);

      assert.deepStrictEqual(
        [pull.mergeableState, pull.body],
        ["dirty", "Please review the implementation."],
      );
    }).pipe(Effect.provide(fetchLayer(fetch)));
  });
});
