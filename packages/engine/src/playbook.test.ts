import { type McpSkill, WorkspaceConfig } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  buildContinuationNudge,
  buildFollowUpPrompt,
  buildImplementPrompt,
  buildTriagePrompt,
  parseFollowUpResult,
  parseTriageDecision,
  parseTriageDisposition,
  resolveFollowUp,
  resolveImplement,
  resolveStage,
  resolveTriage,
  resolveTriageDecision,
} from "./playbook";

const config = (over: Partial<typeof WorkspaceConfig.Encoded> = {}) =>
  Schema.decodeSync(WorkspaceConfig)({
    name: "gh",
    checkoutPath: "/repos/gh",
    issueTracker: { type: "github", repo: "owner/repo" },
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
    assert.strictEqual(resolved.effort, null);
  });

  it("prefers per-stage harness, model, effort, skill, and prompt overrides", () => {
    const resolved = resolveTriage(
      config({
        harness: { preferred: "cursor" },
        playbook: {
          triage: {
            enabled: true,
            harness: "claude",
            model: "opus",
            effort: "high",
            skill: "my-triage",
            prompt: "Do the thing",
          },
        },
      }),
    );
    assert.strictEqual(resolved.enabled, true);
    assert.strictEqual(resolved.harness, "claude");
    assert.strictEqual(resolved.model, "opus");
    assert.strictEqual(resolved.effort, "high");
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

describe("resolveFollowUp", () => {
  it("defaults to the follow-up-agent skill and a one-day resume age with no token cap", () => {
    const resolved = resolveFollowUp(config());
    assert.strictEqual(resolved.enabled, false);
    assert.strictEqual(resolved.skill, "follow-up-agent");
    assert.strictEqual(resolved.resumeMaxAgeMillis, 86_400_000);
    assert.isNull(resolved.resumeMaxTokens);
  });

  it("prefers per-stage resume overrides", () => {
    const resolved = resolveFollowUp(
      config({
        playbook: { "follow-up": { enabled: true, resumeMaxAgeMillis: 5_000, resumeMaxTokens: 42 } },
      }),
    );
    assert.strictEqual(resolved.enabled, true);
    assert.strictEqual(resolved.resumeMaxAgeMillis, 5_000);
    assert.strictEqual(resolved.resumeMaxTokens, 42);
  });
});

describe("resolveStage", () => {
  it("resolves triage, implement, and follow-up, and returns null for unsupported stages", () => {
    const cfg = config({
      playbook: { triage: { enabled: true }, implement: { enabled: true }, "follow-up": { enabled: true } },
    });
    assert.strictEqual(resolveStage(cfg, "triage")?.enabled, true);
    assert.strictEqual(resolveStage(cfg, "implement")?.enabled, true);
    assert.strictEqual(resolveStage(cfg, "follow-up")?.enabled, true);
    assert.isNull(resolveStage(cfg, "verify"));
  });
});

describe("MCP skills", () => {
  it("default to an empty list when the workspace declares none", () => {
    assert.deepStrictEqual(resolveImplement(config()).mcpSkills, []);
  });

  it("carry the workspace's MCP skills, auth reference and all, onto every resolved stage", () => {
    const cfg = config({
      mcpSkills: [
        {
          name: "linear",
          endpoint: "https://mcp.linear.app/mcp/readonly",
          auth: { type: "credential-store" },
        },
      ],
    });
    const expected: ReadonlyArray<McpSkill> = [
      {
        name: "linear",
        endpoint: "https://mcp.linear.app/mcp/readonly",
        auth: { type: "credential-store" },
      },
    ];
    assert.deepStrictEqual(resolveTriage(cfg).mcpSkills, expected);
    assert.deepStrictEqual(resolveImplement(cfg).mcpSkills, expected);
    assert.deepStrictEqual(resolveFollowUp(cfg).mcpSkills, expected);
  });
});

describe("WorkspaceConfig.linearHistory", () => {
  it("defaults to false when the key is omitted", () => {
    assert.strictEqual(config().linearHistory, false);
  });

  it("accepts an explicit true", () => {
    assert.strictEqual(config({ linearHistory: true }).linearHistory, true);
  });
});

describe("buildFollowUpPrompt", () => {
  it("names the skill, forbids merging, and appends the follow-up sentinel", () => {
    const prompt = buildFollowUpPrompt(resolveFollowUp(config()), { id: "#5", title: "in review" }, false);
    assert.include(prompt, "`follow-up-agent`");
    assert.include(prompt, "Never merge");
    assert.include(prompt, "FOLLOWUP-RESULT: <pushed | noop | stuck>");
  });

  it("explains that a healthy PR with nothing to do is a noop, not a failure", () => {
    const prompt = buildFollowUpPrompt(resolveFollowUp(config()), { id: "#5", title: "in review" }, false);
    assert.include(prompt, "Use `noop` when the PR is already healthy");
    assert.include(prompt, "it is not a failure");
  });

  it("states linear history is not required by default", () => {
    const prompt = buildFollowUpPrompt(resolveFollowUp(config()), { id: "#5", title: "in review" }, false);
    assert.include(prompt, "Linear history for this repository is not required.");
  });

  it("states linear history is required when the flag is set", () => {
    const prompt = buildFollowUpPrompt(resolveFollowUp(config()), { id: "#5", title: "in review" }, true);
    assert.include(prompt, "Linear history for this repository is required.");
  });
});

describe("parseFollowUpResult", () => {
  it("reads the last pushed/noop/stuck sentinel", () => {
    assert.strictEqual(parseFollowUpResult("work\nFOLLOWUP-RESULT: pushed"), "pushed");
    assert.strictEqual(parseFollowUpResult("nothing to do\nFOLLOWUP-RESULT: noop"), "noop");
    assert.strictEqual(parseFollowUpResult("FOLLOWUP-RESULT: pushed\nFOLLOWUP-RESULT: stuck"), "stuck");
    assert.isNull(parseFollowUpResult("FOLLOWUP-RESULT: banana"));
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

  it("tells the agent to reuse an existing pull request for the branch instead of opening a second", () => {
    const prompt = buildImplementPrompt(resolveImplement(config()), {
      id: "#15",
      title: "Implement playbook",
    });
    assert.include(prompt, "Only one pull request should ever exist for this branch");
    assert.include(prompt, "push your work to that one instead of opening another");
  });
});

describe("buildContinuationNudge", () => {
  it("sends the agent to the worktree without restating the stage prompt", () => {
    const nudge = buildContinuationNudge("/wt/15-implement-playbook");
    assert.include(nudge, "You were interrupted part-way through the task above");
    assert.include(nudge, "Inspect /wt/15-implement-playbook to see how far you got");
    assert.include(nudge, "Do not start over and do not redo completed work");
    assert.include(nudge, "say COMPLETE and stop");
    assert.include(nudge, "keep using it and never open a second one");
    assert.notInclude(nudge, "implement-agent");
    assert.notInclude(nudge, "IMPLEMENT-RESULT");
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

describe("parseTriageDisposition", () => {
  it("reads the disposition from the proposal prose, bold or plain", () => {
    assert.strictEqual(
      parseTriageDisposition("**Disposition:** ready-for-agent\n\n### Findings"),
      "ready-for-agent",
    );
    assert.strictEqual(parseTriageDisposition("Disposition: needs-info"), "needs-info");
    assert.strictEqual(
      parseTriageDisposition("**Disposition**: ready-for-human (Medium)"),
      "ready-for-human",
    );
  });

  it("returns null when no readable disposition is present", () => {
    assert.isNull(parseTriageDisposition("no disposition here"));
    assert.isNull(parseTriageDisposition("**Disposition:** banana"));
  });
});

describe("resolveTriageDecision", () => {
  it("prefers the sentinel over the disposition and reports the source", () => {
    const decision = resolveTriageDecision(
      "**Disposition:** ready-for-human\nTRIAGE-DECISION: ready-for-agent",
    );
    assert.strictEqual(decision.role, "ready-for-agent");
    assert.strictEqual(decision.source, "sentinel");
    assert.strictEqual(decision.sentinel, "ready-for-agent");
    assert.strictEqual(decision.disposition, "ready-for-human");
  });

  it("backstops a missing sentinel with the proposal disposition", () => {
    const decision = resolveTriageDecision("**Disposition:** ready-for-agent\n\n### Open questions\n- none");
    assert.strictEqual(decision.role, "ready-for-agent");
    assert.strictEqual(decision.source, "disposition");
    assert.isNull(decision.sentinel);
    assert.strictEqual(decision.disposition, "ready-for-agent");
  });

  it("defaults to ready-for-human when neither sentinel nor disposition is readable", () => {
    const decision = resolveTriageDecision("I could not tell what to do.");
    assert.strictEqual(decision.role, "ready-for-human");
    assert.strictEqual(decision.source, "default");
    assert.isNull(decision.sentinel);
    assert.isNull(decision.disposition);
  });
});
