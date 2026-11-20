import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { confine } from "./confinement";

describe("confine", () => {
  it.effect("normalizes a relative path to a worktree-relative path", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* confine("src/foo.ts"), "src/foo.ts");
      assert.strictEqual(yield* confine("./src/./foo.ts"), "src/foo.ts");
      assert.strictEqual(yield* confine("src/bar/../foo.ts"), "src/foo.ts");
    }),
  );

  it.effect("treats a leading slash and the /workspace prefix as the root", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* confine("/src/foo.ts"), "src/foo.ts");
      assert.strictEqual(yield* confine("/workspace/src/foo.ts"), "src/foo.ts");
      assert.strictEqual(yield* confine("/workspace"), "");
    }),
  );

  it.effect("rejects a path that climbs past the worktree root", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(confine("../secrets.txt"));
      assert.strictEqual(error._tag, "ToolError");
      assert.strictEqual(error.reason, "out-of-bounds");
    }),
  );

  it.effect("rejects a climb hidden inside the path", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(confine("src/../../etc/passwd"));
      assert.strictEqual(error.reason, "out-of-bounds");
    }),
  );
});
