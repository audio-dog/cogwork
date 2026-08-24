import { assert, describe, it } from "@effect/vitest";
import { harnessRunners } from "./rpc";

describe("Codex harness registration", () => {
  it("registers Codex beside Cursor and the owned provider", () => {
    assert.deepStrictEqual(
      harnessRunners.map((runner) => runner.name),
      ["cursor", "codex", "provider"],
    );
  });
});
