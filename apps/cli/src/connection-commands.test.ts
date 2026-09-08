import { WorkspaceId } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { formatConnectionMutation, readApiKeyFrom, resolveConnectionSource } from "./connection-commands";

describe("Connection commands", () => {
  it.effect("reads an API key when no source flag is selected", () =>
    Effect.gen(function* () {
      const source = yield* resolveConnectionSource(
        { env: Option.none(), stored: false },
        "github",
        Effect.succeed({ _tag: "ApiKey", key: Redacted.make("secret") }),
      );

      assert.strictEqual(source._tag, "ApiKey");
    }),
  );

  it.effect("keeps an environment variable as an explicit alternate source", () =>
    Effect.gen(function* () {
      const source = yield* resolveConnectionSource(
        { env: Option.some("GITHUB_TOKEN"), stored: false },
        "github",
        Effect.die(new Error("API key input must not be read")),
      );

      assert.deepStrictEqual(source, { _tag: "Env", name: "GITHUB_TOKEN" });
    }),
  );

  it.effect("keeps Linear's saved login as an explicit alternate source", () =>
    Effect.gen(function* () {
      const source = yield* resolveConnectionSource(
        { env: Option.none(), stored: true },
        "linear",
        Effect.die(new Error("API key input must not be read")),
      );

      assert.deepStrictEqual(source, { _tag: "Stored" });
    }),
  );

  it.effect("rejects saved login outside Linear", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        resolveConnectionSource(
          { env: Option.none(), stored: true },
          "github",
          Effect.die(new Error("API key input must not be read")),
        ),
      );

      assert.strictEqual(failure.message, "--stored is available only for Linear browser login");
    }),
  );

  it.effect("rejects conflicting source flags with the valid choices", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        resolveConnectionSource(
          { env: Option.some("GITHUB_TOKEN"), stored: true },
          "github",
          Effect.die(new Error("API key input must not be read")),
        ),
      );

      assert.strictEqual(
        failure.message,
        "--env and --stored cannot be used together; omit both to read an API key from stdin",
      );
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
