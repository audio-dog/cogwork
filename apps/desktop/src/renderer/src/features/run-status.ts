import type { RunStatus } from "@cogwork/contracts";

export const runStatusLabel: Record<RunStatus, string> = {
  running: "Running",
  succeeded: "Succeeded",
  declined: "PR creation declined",
  failed: "Failed",
  exhausted: "Exhausted",
  interrupted: "Interrupted",
  crashed: "Crashed",
};
