import type { LifecycleStage } from "@cogwork/contracts";

export type OperationPolicyProfile = "read-only" | "full";

export const operationPolicyProfile = (stage: LifecycleStage): OperationPolicyProfile =>
  stage === "implement" || stage === "follow-up" ? "full" : "read-only";
