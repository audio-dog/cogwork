import { defineWorkspace } from "engine";

export default defineWorkspace({
  name: "audiodog",
  checkoutPath: "/repos/audiodog",
  workSource: { type: "linear" },
  harness: { preferred: "cursor" },
  playbook: {
    triage: { enabled: true },
    implement: { enabled: true, harness: "cursor" },
    verify: { enabled: true },
  },
});
