import type { CursorModel } from "@cogwork/cursor-acp";
import { defineWorkspace } from "@cogwork/engine";

const triageModel = "composer-2.5" satisfies CursorModel;
const implementModel = "claude-opus-4-8-thinking-medium" satisfies CursorModel;
const followUpModel = "composer-2.5" satisfies CursorModel;

export default defineWorkspace({
  name: "cogwork",
  checkoutPath: "/Users/taylorsteele/sites/cogwork",
  issueTracker: {
    type: "github",
    repo: "colonylabs/cogwork",
    tokenEnv: "GITHUB_TOKEN",
    actorLogin: "taylorfsteele",
  },
  harness: { preferred: "cursor" },
  concurrency: 3,
  playbook: {
    triage: { enabled: true, model: triageModel },
    implement: { enabled: true, model: implementModel },
    "follow-up": { enabled: true, model: followUpModel },
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
