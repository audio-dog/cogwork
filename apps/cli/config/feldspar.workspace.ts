import type { CursorModel } from "@clanker-forge/cursor-acp";
import { defineWorkspace } from "@clanker-forge/engine";

const triageModel = "composer-2.5" satisfies CursorModel;

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
  harness: { preferred: "cursor" },
  concurrency: 1,
  playbook: {
    triage: { enabled: true, model: triageModel },
  },
});
