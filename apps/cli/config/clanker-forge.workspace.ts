import { defineWorkspace } from "@clanker-forge/engine";

export default defineWorkspace({
  name: "clanker-forge",
  checkoutPath: "/repos/clanker-forge",
  workSource: {
    type: "github",
    repo: "taylorfsteele/clanker-forge",
    tokenEnv: "GITHUB_TOKEN",
    botLogin: "clanker-forge[bot]",
  },
  harness: { preferred: "cursor" },
  playbook: {
    triage: { enabled: true },
    implement: { enabled: true, harness: "cursor" },
    "follow-up": { enabled: true },
    verify: { enabled: true },
  },
});
