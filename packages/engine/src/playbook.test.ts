import { WorkspaceConfig } from "@clanker-forge/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { buildTriagePrompt, parseTriageDecision, resolveTriage } from "./Playbook";

const config = (over: Partial<typeof WorkspaceConfig.Encoded> = {}) =>
  Schema.decodeSync(WorkspaceConfig)({
    name: "gh",
    checkoutPath: "/repos/gh",
    workSource: { type: "github", repo: "owner/repo" },
    harness: { preferred: "cursor" },
    ...over,
  });

describe("resolveTriage", () => {
  it("falls back to the workspace harness and default skill/prompt when the stage is unset", () => {
    const resolved = resolveTriage(config());
    assert.strictEqual(resolved.enabled, false);
    assert.strictEqual(resolved.harness, "cursor");
    assert.strictEqual(resolved.skill, "triage");
    assert.strictEqual(resolved.model, null);
  });

  it("prefers per-stage harness, model, skill, and prompt overrides", () => {
    const resolved = resolveTriage(
      config({
        harness: { preferred: "cursor" },
        playbook: {
          triage: {
            enabled: true,
            harness: "claude",
            model: "opus",
            skill: "my-triage",
            prompt: "Do the thing",
          },
        },
      }),
    );
    assert.strictEqual(resolved.enabled, true);
    assert.strictEqual(resolved.harness, "claude");
    assert.strictEqual(resolved.model, "opus");
    assert.strictEqual(resolved.skill, "my-triage");
    assert.strictEqual(resolved.promptTemplate, "Do the thing");
  });
});

describe("buildTriagePrompt", () => {
  it("interpolates the item and skill and appends the decision protocol", () => {
    const prompt = buildTriagePrompt(resolveTriage(config()), { id: "#7", title: "broken export" });
    assert.include(prompt, "#7");
    assert.include(prompt, "broken export");
    assert.include(prompt, "`triage`");
    assert.include(prompt, "TRIAGE-DECISION: <ready-for-agent | ready-for-human | needs-info | wontfix>");
  });
});

describe("parseTriageDecision", () => {
  it("reads a valid decision role", () => {
    assert.strictEqual(parseTriageDecision("blah\nTRIAGE-DECISION: ready-for-agent"), "ready-for-agent");
  });

  it("takes the last decision when several appear", () => {
    assert.strictEqual(
      parseTriageDecision("TRIAGE-DECISION: needs-info\n...\nTRIAGE-DECISION: wontfix"),
      "wontfix",
    );
  });

  it("returns null for an unknown or missing decision", () => {
    assert.isNull(parseTriageDecision("TRIAGE-DECISION: banana"));
    assert.isNull(parseTriageDecision("no decision here"));
  });
});
