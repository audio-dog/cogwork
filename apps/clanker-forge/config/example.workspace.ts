import { defineWorkspace } from "@clanker-forge/engine";

export default defineWorkspace({
  name: "example",
  checkoutPath: "/repos/example",
  workSource: { type: "linear" },
  harness: { preferred: "cursor" },
  playbook: {
    triage: { enabled: true },
    implement: { enabled: true, harness: "cursor" },
    verify: { enabled: true },
  },
});
