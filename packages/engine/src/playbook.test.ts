import {
  type FollowUpResultOutcome,
  FollowUpStageResult,
  type ImplementResultOutcome,
  ImplementStageResult,
  type McpSkill,
  type TriageResultRole,
  TriageStageResult,
  WorkspaceConfig,
} from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  buildContinuationNudge,
  buildFollowUpPrompt,
  buildImplementPrompt,
  buildTriagePrompt,
  type OperationOutcome,
  resolveFollowUp,
  resolveImplement,
  resolveStage,
  resolveTriage,
} from "./playbook";

const config = (over: Partial<typeof WorkspaceConfig.Encoded> = {}) =>
  Schema.decodeSync(WorkspaceConfig)({
    name: "gh",
    checkoutPath: "/repos/gh",
    issueTracker: { type: "github" },
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

describe("operation outcome tables", () => {
  const triageResult = (role: TriageResultRole) =>
    Schema.decodeSync(TriageStageResult)({ _tag: "triage", role, proposal: `Move to ${role}.` });

  const implementResult = (outcome: ImplementResultOutcome) =>
    Schema.decodeSync(ImplementStageResult)({ _tag: "implement", outcome, summary: `Result: ${outcome}.` });

  const followUpResult = (outcome: FollowUpResultOutcome) =>
    Schema.decodeSync(FollowUpStageResult)({ _tag: "follow-up", outcome, summary: `Result: ${outcome}.` });

  const triageCases = [
    {
      name: "ready-for-agent",
      result: triageResult("ready-for-agent"),
      expected: { coordination: "triaged", attempt: "succeeded" },
    },
    {
      name: "needs-info",
      result: triageResult("needs-info"),
      expected: { coordination: "triaged", attempt: "succeeded" },
    },
    {
      name: "ready-for-human",
      result: triageResult("ready-for-human"),
      expected: { coordination: "triaged", attempt: "succeeded" },
    },
    {
      name: "wontfix",
      result: triageResult("wontfix"),
      expected: { coordination: "triaged", attempt: "succeeded" },
    },
  ] satisfies ReadonlyArray<{
    readonly name: TriageResultRole;
    readonly result: TriageStageResult;
    readonly expected: OperationOutcome;
  }>;

  const implementCases = [
    {
      name: "opened-pr",
      result: implementResult("opened-pr"),
      expected: { coordination: "implemented", attempt: "succeeded" },
    },
    {
      name: "stuck",
      result: implementResult("stuck"),
      expected: { coordination: "attemptFailed", attempt: "failed", retryable: false },
    },
  ] satisfies ReadonlyArray<{
    readonly name: ImplementResultOutcome;
    readonly result: ImplementStageResult;
    readonly expected: OperationOutcome;
  }>;

  const followUpCases = [
    {
      name: "pushed",
      result: followUpResult("pushed"),
      expected: { coordination: "followedUp", attempt: "succeeded" },
    },
    {
      name: "noop",
      result: followUpResult("noop"),
      expected: { coordination: "followedUp", attempt: "succeeded" },
    },
    {
      name: "stuck",
      result: followUpResult("stuck"),
      expected: { coordination: "attemptFailed", attempt: "failed", retryable: false },
    },
  ] satisfies ReadonlyArray<{
    readonly name: FollowUpResultOutcome;
    readonly result: FollowUpStageResult;
    readonly expected: OperationOutcome;
  }>;

  describe("triage", () => {
    const table = resolveTriage(config()).outcomeTable;

    it("declares every result", () => {
      assert.deepStrictEqual(
        Object.keys(table.outcomes),
        triageCases.map(({ name }) => name),
      );
    });

    it.each(triageCases)("maps $name to triaged success", ({ result, expected }) => {
      assert.strictEqual(table.resultField, "role");
      assert.deepStrictEqual(table.outcomes[result.role], expected);
    });
  });

  describe("implementation", () => {
    const table = resolveImplement(config()).outcomeTable;

    it("declares every result", () => {
      assert.deepStrictEqual(
        Object.keys(table.outcomes),
        implementCases.map(({ name }) => name),
      );
    });

    it.each(implementCases)("maps $name to its current completion", ({ result, expected }) => {
      assert.strictEqual(table.resultField, "outcome");
      assert.deepStrictEqual(table.outcomes[result.outcome], expected);
    });
  });

  describe("follow-up", () => {
    const table = resolveFollowUp(config()).outcomeTable;

    it("declares every result", () => {
      assert.deepStrictEqual(
        Object.keys(table.outcomes),
        followUpCases.map(({ name }) => name),
      );
    });

    it.each(followUpCases)("maps $name to its current completion", ({ result, expected }) => {
      assert.strictEqual(table.resultField, "outcome");
      assert.deepStrictEqual(table.outcomes[result.outcome], expected);
    });
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
    assert.include(nudge, "prepared Worktree as ground truth");
    assert.include(nudge, "Do not trust the ragged tail");
    assert.include(nudge, "say COMPLETE and stop");
    assert.include(nudge, "keep using it and never open a second one");
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
