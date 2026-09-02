import { assert, describe, it } from "@effect/vitest";
import { harnessRunners } from "./rpc";

describe("external harness registration", () => {
  it("registers Claude Code and Codex beside Cursor and the owned provider", () => {
    assert.deepStrictEqual(
      harnessRunners.map((runner) => runner.name),
      ["cursor", "claude", "codex", "provider"],
    );
  });
});
