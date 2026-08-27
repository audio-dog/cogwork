import type { CodexEffort, CodexModel } from "@cogwork/codex-cli";
import { defineWorkspace } from "@cogwork/engine";

const model = "gpt-5.6-sol" satisfies CodexModel;
const effort = "high" satisfies CodexEffort;

export default defineWorkspace({
  name: "cogwork",
  checkoutPath: "/Users/taylorsteele/sites/cogwork",
  issueTracker: {
    type: "github",
    repo: "colonylabs/cogwork",
    tokenEnv: "GITHUB_TOKEN",
    actorLogin: "taylorfsteele",
  },
  harness: { preferred: "codex" },
  concurrency: 3,
  playbook: {
    triage: { enabled: true, model, effort },
    implement: { enabled: true, model, effort },
    "follow-up": { enabled: true, model, effort },
    verify: { enabled: true },
  },
  worktrees: {
    linkPaths: [".env"],
    setup: ["pnpm install", "pnpm setup-worktree"],
    reapAfterMillis: 604_800_000,
  },
  sourceControl: {
    type: "github",
    repo: "colonylabs/cogwork",
    tokenEnv: "GITHUB_TOKEN",
    actorLogin: "taylorfsteele",
    botAllowlist: ["cursor[bot]"],
  },
});
