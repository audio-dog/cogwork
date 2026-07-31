import { defineWorkspace } from "@clanker-forge/engine";

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
    triage: { enabled: true },
    implement: { enabled: true, harness: "cursor" },
    "follow-up": { enabled: true },
    verify: { enabled: true },
  },
  worktrees: {
    linkEnvFiles: [".env"],
    setup: ["pnpm install"],
    reapAfterMillis: 604_800_000,
  },
});
