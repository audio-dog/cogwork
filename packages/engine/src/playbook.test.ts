import { type McpSkill, WorkspaceConfig } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  buildContinuationNudge,
  buildFollowUpPrompt,
  buildImplementPrompt,
  buildTriagePrompt,
  resolveFollowUp,
  resolveImplement,
  resolveStage,
  resolveTriage,
} from "./playbook";

const config = (over: Partial<typeof WorkspaceConfig.Encoded> = {}) =>
  Schema.decodeSync(WorkspaceConfig)({
    name: "gh",
    checkoutPath: "/repos/gh",
    issueTracker: { type: "github", repo: "owner/repo" },
    ...over,
  });

describe("resolveTriage", () => {
  it("falls back to the default skill and prompt when the stage is unset", () => {
    const resolved = resolveTriage(config());
    assert.strictEqual(resolved.skill, "triage-agent");
    assert.isNull(resolved.resumeMaxAgeMillis);
  });
});

describe("resolveImplement", () => {
  it("defaults to the implement-agent skill when the stage is unset", () => {
    assert.strictEqual(resolveImplement(config()).skill, "implement-agent");
  });
});

describe("resolveFollowUp", () => {
  it("defaults to the follow-up-agent skill and a one-day resume age with no token cap", () => {
    const resolved = resolveFollowUp(config());
    assert.strictEqual(resolved.skill, "follow-up-agent");
    assert.strictEqual(resolved.resumeMaxAgeMillis, 86_400_000);
    assert.isNull(resolved.resumeMaxTokens);
  });
});

describe("resolveStage", () => {
  it("resolves every operation", () => {
    const cfg = config();
    assert.strictEqual(resolveStage(cfg, "triage").skill, "triage-agent");
    assert.strictEqual(resolveStage(cfg, "implement").skill, "implement-agent");
    assert.strictEqual(resolveStage(cfg, "follow-up").skill, "follow-up-agent");
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
  it("names the skill and forbids merging without a text result protocol", () => {
    const prompt = buildFollowUpPrompt(resolveFollowUp(config()), { id: "#5", title: "in review" }, false);
    assert.include(prompt, "`follow-up-agent`");
    assert.include(prompt, "Never merge");
  });

  it("does not describe structured outcomes in the agent prompt", () => {
    const prompt = buildFollowUpPrompt(resolveFollowUp(config()), { id: "#5", title: "in review" }, false);
    assert.notInclude(prompt, "structured outcomes");
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

describe("buildImplementPrompt", () => {
  it("interpolates the item and names the skill without a text result protocol", () => {
    const prompt = buildImplementPrompt(resolveImplement(config()), {
      id: "#15",
      title: "Implement playbook",
    });
    assert.include(prompt, "#15");
    assert.include(prompt, "Implement playbook");
    assert.include(prompt, "`implement-agent`");
    assert.notInclude(prompt, "TRIAGE-DECISION");
    assert.notInclude(prompt, "IMPLEMENT-RESULT");
  });

  it("tells the agent to prepare pull request content for the engine", () => {
    const prompt = buildImplementPrompt(resolveImplement(config()), {
      id: "#15",
      title: "Implement playbook",
    });
    assert.include(prompt, "The engine opens the pull request");
    assert.include(prompt, "Push the prepared branch");
    assert.include(prompt, "Return a ready-for-pr result");
    assert.notInclude(prompt, "open a pull request that references");
  });
});

describe("buildContinuationNudge", () => {
  it("sends the agent to the worktree without restating the stage prompt", () => {
    const nudge = buildContinuationNudge("/wt/15-implement-playbook");
    assert.include(nudge, "You were interrupted part-way through the task above");
    assert.include(nudge, "Inspect /wt/15-implement-playbook to see how far you got");
    assert.include(nudge, "Do not start over and do not redo completed work");
    assert.include(nudge, "prepared Worktree as ground truth");
    assert.include(nudge, "Do not trust the ragged tail");
    assert.include(nudge, "say COMPLETE and stop");
    assert.include(nudge, "prepare the pull request title and body for the engine");
    assert.include(nudge, "push the prepared branch");
    assert.notInclude(nudge, "open a second one");
    assert.notInclude(nudge, "implement-agent");
  });
});

describe("buildTriagePrompt", () => {
  it("interpolates the item and skill without a text result protocol", () => {
    const prompt = buildTriagePrompt(resolveTriage(config()), { id: "#7", title: "broken export" });
    assert.include(prompt, "#7");
    assert.include(prompt, "broken export");
    assert.include(prompt, "`triage-agent`");
    assert.notInclude(prompt, "TRIAGE-DECISION");
  });
});
