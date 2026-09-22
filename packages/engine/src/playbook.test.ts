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
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
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

  const implementResult = (outcome: ImplementResultOutcome) => {
    const summary = `Result: ${outcome}.`;
    if (outcome !== "ready-for-pr") {
      return Schema.decodeSync(ImplementStageResult)({ _tag: "implement", outcome, summary });
    }
    return Schema.decodeSync(ImplementStageResult)({
      _tag: "implement",
      outcome,
      summary,
      title: "Ready pull request",
      body: "Ready.",
    });
  };

  const followUpResult = (outcome: FollowUpResultOutcome) =>
    outcome === "noop"
      ? Schema.decodeSync(FollowUpStageResult)({
          _tag: "follow-up",
          outcome,
          summary: `Result: ${outcome}.`,
          speak: false,
        })
      : Schema.decodeSync(FollowUpStageResult)({
          _tag: "follow-up",
          outcome,
          summary: `Result: ${outcome}.`,
        });

  const triageCases = [
    {
      name: "ready-for-agent",
      result: triageResult("ready-for-agent"),
      expected: { _tag: "Triaged", result: "ready-for-agent" },
    },
    {
      name: "needs-info",
      result: triageResult("needs-info"),
      expected: { _tag: "Triaged", result: "needs-info" },
    },
    {
      name: "ready-for-human",
      result: triageResult("ready-for-human"),
      expected: { _tag: "Triaged", result: "ready-for-human" },
    },
    {
      name: "wontfix",
      result: triageResult("wontfix"),
      expected: { _tag: "Triaged", result: "wontfix" },
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
      expected: { _tag: "Implemented", result: "opened-pr" },
    },
    {
      name: "ready-for-pr",
      result: implementResult("ready-for-pr"),
      expected: { _tag: "PullRequestReady", result: "ready-for-pr" },
    },
    {
      name: "stuck",
      result: implementResult("stuck"),
      expected: { _tag: "Failed", result: "stuck", retryable: false },
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
      expected: { _tag: "FollowedUp", result: "pushed" },
    },
    {
      name: "noop",
      result: followUpResult("noop"),
      expected: { _tag: "FollowedUp", result: "noop" },
    },
    {
      name: "stuck",
      result: followUpResult("stuck"),
      expected: { _tag: "Failed", result: "stuck", retryable: false },
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
        table.outcomes.map(({ result }) => result),
        triageCases.map(({ name }) => name),
      );
    });

    it.each(triageCases)("maps $name to triaged success", ({ result, expected }) => {
      assert.deepStrictEqual(
        table.outcomes.find((outcome) => outcome.result === result.role),
        expected,
      );
    });
  });

  describe("implementation", () => {
    const table = resolveImplement(config()).outcomeTable;

    it("declares every result", () => {
      assert.deepStrictEqual(
        table.outcomes.map(({ result }) => result),
        implementCases.map(({ name }) => name),
      );
    });

    it.each(implementCases)("maps $name to its current completion", ({ result, expected }) => {
      assert.deepStrictEqual(
        table.outcomes.find((outcome) => outcome.result === result.outcome),
        expected,
      );
    });
  });

  describe("follow-up", () => {
    const table = resolveFollowUp(config()).outcomeTable;

    it("declares every result", () => {
      assert.deepStrictEqual(
        table.outcomes.map(({ result }) => result),
        followUpCases.map(({ name }) => name),
      );
    });

    it.each(followUpCases)("maps $name to its current completion", ({ result, expected }) => {
      assert.deepStrictEqual(
        table.outcomes.find((outcome) => outcome.result === result.outcome),
        expected,
      );
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

describe("follow-up Operating Instructions", () => {
  it.effect("makes the speaking decision agent-owned and posting engine-owned", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const instructions = yield* fs.readFileString(
        decodeURIComponent(
          new URL("../operating-instructions/follow-up-agent/INSTRUCTIONS.md", import.meta.url).pathname,
        ),
      );

      assert.include(instructions, "choose whether to speak");
      assert.include(instructions, "Do not post it as a PR comment yourself");
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
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

describe("implement Operating Instructions", () => {
  it.effect("keeps pull-request opening engine-owned", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const instructions = yield* fs.readFileString(
        decodeURIComponent(
          new URL("../operating-instructions/implement-agent/INSTRUCTIONS.md", import.meta.url).pathname,
        ),
      );
      const pullRequestOpeningLines = instructions
        .split("\n")
        .filter(
          (line) =>
            /\b(?:open(?:s|ing)?|creat(?:e|es|ing))\b/i.test(line) && /\b(?:PR|pull request)\b/i.test(line),
        );

      assert.lengthOf(pullRequestOpeningLines, 4);
      assert.include(instructions, "Never open or merge a pull request");
      assert.include(instructions, "Commit and push the engine-owned branch");
      assert.include(instructions, "Return `ready-for-pr` with that title and body");
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
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
