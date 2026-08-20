import { assert, describe, it } from "@effect/vitest";
import cogwork from "../config/cogwork.workspace";
import { harnessRunners } from "./rpc";

describe("Codex harness registration", () => {
  it("registers Codex beside Cursor and the owned provider", () => {
    assert.deepStrictEqual(
      harnessRunners.map((runner) => runner.name),
      ["cursor", "codex", "provider"],
    );
  });

  it("selects Codex with gpt-5.6-sol and high effort for Cogwork playbooks", () => {
    assert.strictEqual(cogwork.harness.preferred, "codex");
    const stages = [cogwork.playbook?.triage, cogwork.playbook?.implement, cogwork.playbook?.["follow-up"]];
    stages.forEach((stage) => {
      assert.strictEqual(stage?.model, "gpt-5.6-sol");
      assert.strictEqual(stage?.effort, "high");
    });
  });
});
