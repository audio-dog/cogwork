import type { CursorModel } from "@clanker-forge/cursor-acp";
import { defineWorkspace } from "@clanker-forge/engine";

const triageModel = "composer-2.5" satisfies CursorModel;
const implementModel = "claude-opus-4-8-thinking-high" satisfies CursorModel;
const followUpModel = "composer-2.5" satisfies CursorModel;

export default defineWorkspace({
  name: "feldspar",
  checkoutPath: "/Users/taylorsteele/sites/feldspar",
  workSource: {
    type: "linear",
    team: "FEL",
    tokenEnv: "LINEAR_API_KEY",
    botUserId: "02051c43-a071-42bd-9bae-8f6ede983375",
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
    repo: "colonylabs/feldspar",
    tokenEnv: "GITHUB_TOKEN",
    botLogin: "audiodog-bot",
  },
  harness: { preferred: "cursor" },
  concurrency: 3,
  playbook: {
    triage: { enabled: true, model: triageModel },
    implement: { enabled: true, model: implementModel },
    "follow-up": { enabled: true, model: followUpModel },
    verify: { enabled: true },
  },
});
