import type { CursorModel } from "@cogwork/cursor-acp";
import { defineWorkspace } from "@cogwork/engine";

const triageModel = "claude-opus-4-8-thinking-high" satisfies CursorModel;
const implementModel = "claude-opus-4-8-thinking-high" satisfies CursorModel;
const followUpModel = "composer-2.5" satisfies CursorModel;

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
    triage: { enabled: true, model: triageModel },
    implement: { enabled: true, model: implementModel },
    "follow-up": { enabled: true, model: followUpModel },
    verify: { enabled: true },
  },
  worktrees: {
    setup: ["./scripts/bootstrap-worktree.sh"],
    reapAfterMillis: 604_800_000,
  },
});
