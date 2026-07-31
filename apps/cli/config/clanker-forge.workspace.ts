import type { CursorEffort, CursorModel } from "@clanker-forge/cursor-acp";
import { defineWorkspace } from "@clanker-forge/engine";

const triageModel = "composer-2.5" satisfies CursorModel;
const implementModel = "claude-opus-4-8" satisfies CursorModel;
const implementEffort = "high" satisfies CursorEffort;
const followUpModel = "claude-sonnet-5-thinking-medium" satisfies CursorModel;

export default defineWorkspace({
  name: "clanker-forge",
  checkoutPath: "/Users/taylorsteele/sites/clanker-forge",
  workSource: {
    type: "github",
    repo: "taylorfsteele/clanker-forge",
    tokenEnv: "GITHUB_TOKEN",
    botLogin: "audiodog-bot",
  },
  harness: { preferred: "cursor" },
  concurrency: 1,
  playbook: {
    triage: { enabled: true, model: triageModel },
    implement: {
      enabled: true,
      harness: "cursor",
      model: implementModel,
      effort: implementEffort,
    },
    "follow-up": { enabled: true, model: followUpModel },
    verify: { enabled: true },
  },
  worktrees: {
    linkEnvFiles: [".env"],
    setup: ["pnpm install"],
    reapAfterMillis: 604_800_000,
  },
});
