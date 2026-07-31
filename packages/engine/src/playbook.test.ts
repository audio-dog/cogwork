import { WorkspaceConfig } from "@clanker-forge/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  buildImplementPrompt,
  buildTriagePrompt,
  parseTriageDecision,
  resolveImplement,
  resolveStage,
  resolveTriage,
} from "./Playbook";

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
    assert.strictEqual(resolved.skill, "triage-agent");
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

describe("resolveImplement", () => {
  it("defaults to the implement-agent skill and workspace harness when the stage is unset", () => {
    const resolved = resolveImplement(config());
    assert.strictEqual(resolved.enabled, false);
    assert.strictEqual(resolved.harness, "cursor");
    assert.strictEqual(resolved.skill, "implement-agent");
    assert.strictEqual(resolved.model, null);
  });

  it("prefers per-stage overrides", () => {
    const resolved = resolveImplement(
      config({
        playbook: { implement: { enabled: true, harness: "claude", model: "opus", skill: "my-impl" } },
      }),
    );
    assert.strictEqual(resolved.enabled, true);
    assert.strictEqual(resolved.harness, "claude");
    assert.strictEqual(resolved.model, "opus");
    assert.strictEqual(resolved.skill, "my-impl");
  });
});

describe("resolveStage", () => {
  it("resolves triage and implement, and returns null for unsupported stages", () => {
    const cfg = config({ playbook: { triage: { enabled: true }, implement: { enabled: true } } });
    assert.strictEqual(resolveStage(cfg, "triage")?.enabled, true);
    assert.strictEqual(resolveStage(cfg, "implement")?.enabled, true);
    assert.isNull(resolveStage(cfg, "verify"));
    assert.isNull(resolveStage(cfg, "follow-up"));
  });
});

describe("buildImplementPrompt", () => {
  it("interpolates the item and names the skill without a decision protocol", () => {
    const prompt = buildImplementPrompt(resolveImplement(config()), {
      id: "#15",
      title: "Implement playbook",
    });
    assert.include(prompt, "#15");
    assert.include(prompt, "Implement playbook");
    assert.include(prompt, "`implement-agent`");
    assert.notInclude(prompt, "TRIAGE-DECISION");
  });
});

describe("buildTriagePrompt", () => {
  it("interpolates the item and skill and appends the decision protocol", () => {
    const prompt = buildTriagePrompt(resolveTriage(config()), { id: "#7", title: "broken export" });
    assert.include(prompt, "#7");
    assert.include(prompt, "broken export");
    assert.include(prompt, "`triage-agent`");
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
