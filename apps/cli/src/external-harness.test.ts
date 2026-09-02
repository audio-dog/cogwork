import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { harnessRunners } from "./rpc";

describe("external harness registration", () => {
  it.effect("registers Claude Code and Codex beside Cursor and the owned provider", () =>
    Effect.gen(function* () {
      const runners = yield* harnessRunners;
      assert.deepStrictEqual(
        runners.map((runner) => runner.name),
        ["cursor", "claude", "codex", "provider", "replay"],
      );
    }),
  );
});
