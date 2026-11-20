import { WorkspaceId } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  establishmentOf,
  formatConnectionMutation,
  readApiKeyFrom,
  resolveConnectionSource,
} from "./connection-commands";

const browserLoginSystems: ReadonlyArray<"linear" | "granola"> = ["linear", "granola"];

describe("Connection commands", () => {
  it.effect("reads an API key when no source flag is selected", () =>
    Effect.gen(function* () {
      const source = yield* resolveConnectionSource(
        { env: Option.none(), githubCli: false, stored: false },
        "github",
        Effect.succeed({ _tag: "ApiKey", key: Redacted.make("secret") }),
      );

      assert.strictEqual(source._tag, "ApiKey");
    }),
  );

  it.effect("keeps an environment variable as an explicit alternate source", () =>
    Effect.gen(function* () {
      const source = yield* resolveConnectionSource(
        { env: Option.some("GITHUB_TOKEN"), githubCli: false, stored: false },
        "github",
        Effect.die(new Error("API key input must not be read")),
      );

      assert.deepStrictEqual(source, { _tag: "Env", name: "GITHUB_TOKEN" });
    }),
  );

  it.effect("keeps browser logins as explicit alternate sources", () =>
    Effect.gen(function* () {
      const sources = yield* Effect.forEach(browserLoginSystems, (system) =>
        resolveConnectionSource(
          { env: Option.none(), githubCli: false, stored: true },
          system,
          Effect.die(new Error("API key input must not be read")),
        ),
      );

      assert.deepStrictEqual(sources, [{ _tag: "Stored" }, { _tag: "Stored" }]);
    }),
  );

  it.effect("rejects saved login outside browser-login systems", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        resolveConnectionSource(
          { env: Option.none(), githubCli: false, stored: true },
          "github",
          Effect.die(new Error("API key input must not be read")),
        ),
      );

      assert.strictEqual(failure.message, "--stored is available only for browser-login Connections");
    }),
  );

  it.effect("rejects conflicting source flags with the valid choices", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        resolveConnectionSource(
          { env: Option.some("GITHUB_TOKEN"), githubCli: false, stored: true },
          "github",
          Effect.die(new Error("API key input must not be read")),
        ),
      );

      assert.strictEqual(
        failure.message,
        "Choose only one credential source: --env, --github-cli, or --stored",
      );
    }),
  );

  it.effect("selects the GitHub CLI without reading stdin", () =>
    Effect.gen(function* () {
      const source = yield* resolveConnectionSource(
        { env: Option.none(), githubCli: true, stored: false },
        "github",
        Effect.die(new Error("API key input must not be read")),
      );

      assert.deepStrictEqual(source, { _tag: "GitHubCli" });
    }),
  );

  it.effect("rejects the GitHub CLI source outside GitHub", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        resolveConnectionSource(
          { env: Option.none(), githubCli: true, stored: false },
          "linear",
          Effect.die(new Error("API key input must not be read")),
        ),
      );

      assert.strictEqual(failure.message, "--github-cli is available only for GitHub Connections");
    }),
  );

  it.effect("rejects a typed GitHub account", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        establishmentOf("github", Option.some("octocat"), { _tag: "GitHubCli" }),
      );

      assert.strictEqual(
        failure.message,
        "GitHub Connections discover the account; omit the account argument",
      );
    }),
  );

  it.effect("routes Slack to browser sign-in", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        resolveConnectionSource(
          { env: Option.none(), githubCli: false, stored: false },
          "slack",
          Effect.succeed({ _tag: "ApiKey", key: Redacted.make("must-not-be-read") }),
        ),
      );

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.strictEqual(
          result.failure.message,
          "Slack Connections use browser sign-in; run cogwork login slack",
        );
      }
    }),
  );

  it.effect("builds a Granola establishment from a pasted key", () =>
    Effect.gen(function* () {
      const invalid = yield* Effect.flip(
        establishmentOf("granola", Option.some("person@example.com"), {
          _tag: "ApiKey",
          key: Redacted.make("wrong-prefix"),
        }),
      );
      const source = yield* readApiKeyFrom(
        Stream.toAsyncIterable(Stream.make(new TextEncoder().encode("grn_secret\n"))),
      );
      const establishment = yield* establishmentOf("granola", Option.some("person@example.com"), source);

      assert.strictEqual(invalid._tag, "ConnectionFailure");
      assert.strictEqual(invalid.operation, "parse Connection API key");
      assert.strictEqual(invalid.message, "Granola API keys must start with grn_");
      assert.strictEqual(establishment.system, "granola");
      assert.strictEqual(establishment.account, "person@example.com");
      assert.strictEqual(establishment.source._tag, "ApiKey");
    }),
  );

  it.effect("rejects API key input larger than 64 KiB", () =>
    Effect.gen(function* () {
      const input = Stream.toAsyncIterable(Stream.make(new Uint8Array(65_537)));
      const failure = yield* Effect.flip(readApiKeyFrom(input));

      assert.strictEqual(failure.message, "API key input exceeds 64 KiB");
    }),
  );

  it("names dangling workspaces after removal", () => {
    const workspaceId = Schema.decodeSync(WorkspaceId);
    assert.strictEqual(
      formatConnectionMutation("Removed", {
        overview: { connections: [] },
        danglingWorkspaces: [workspaceId("alpha"), workspaceId("beta")],
      }),
      "Removed Connection.\nWarning: Workspaces left dangling: alpha, beta.",
    );
  });
});
