import type { CodexEffort, CodexModel } from "@cogwork/codex-cli";
import { defineWorkspace } from "@cogwork/engine";

const model = "gpt-5.6-terra" satisfies CodexModel;
const effort = "medium" satisfies CodexEffort;

const taylor = "02051c43-a071-42bd-9bae-8f6ede983375";

export default defineWorkspace({
  name: "colony",
  checkoutPath: "/Users/taylorsteele/sites/colony",
  issueTracker: {
    type: "linear",
    teams: ["GRO", "BIL"],
    tokenEnv: "LINEAR_API_KEY",
    actorUserId: taylor,
    assigneeAllowlist: [taylor],
    roleLabels: {
      "needs-triage": "needs-triage",
      "ready-for-agent": "ready-for-agent",
      "needs-info": "needs-info",
      "ready-for-human": "ready-for-human",
      wontfix: "wontfix",
    },
  },
  sourceControl: {
    type: "github",
    repo: "colonylabs/colony",
    tokenEnv: "GITHUB_TOKEN",
    actorLogin: "taylorfsteele",
    botAllowlist: ["cursor[bot]"],
  },
  harness: { preferred: "cursor" },
  mcpSkills: [
    {
      name: "linear",
      endpoint: "https://mcp.linear.app/mcp/readonly",
      auth: { type: "credential-store" },
    },
  ],
  concurrency: 3,
  playbook: {
    triage: { enabled: true, model, effort },
    implement: { enabled: true, model, effort },
    "follow-up": { enabled: true, model, effort },
    verify: { enabled: true },
  },
  worktrees: {
    setup: ["./scripts/bootstrap-worktree.sh"],
    reapAfterMillis: 604_800_000,
  },
});
