export type ResumeReason = "no-session" | "fresh-requested" | "worktree-recreated" | "stale" | "token-limit";

export type ResumeDecision =
  | { readonly kind: "resume"; readonly handle: string }
  | { readonly kind: "fresh"; readonly reason: ResumeReason };

export interface ResumeInputs {
  readonly handle: string | null;
  readonly lastRunStartedAtMillis: number | null;
  readonly lastRunTotalTokens: number | null;
  readonly now: number;
  readonly worktreeRecreated: boolean;
  readonly fresh: boolean;
  readonly maxAgeMillis: number | null;
  readonly maxTokens: number | null;
}

const agedOut = (inputs: ResumeInputs) =>
  inputs.maxAgeMillis !== null &&
  inputs.lastRunStartedAtMillis !== null &&
  inputs.now - inputs.lastRunStartedAtMillis > inputs.maxAgeMillis;

const overTokenLimit = (inputs: ResumeInputs) =>
  inputs.maxTokens !== null &&
  inputs.lastRunTotalTokens !== null &&
  inputs.lastRunTotalTokens > inputs.maxTokens;

export const decideResume = (inputs: ResumeInputs): ResumeDecision => {
  if (!inputs.handle) return { kind: "fresh", reason: "no-session" };
  if (inputs.fresh) return { kind: "fresh", reason: "fresh-requested" };
  if (inputs.worktreeRecreated) return { kind: "fresh", reason: "worktree-recreated" };
  if (agedOut(inputs)) return { kind: "fresh", reason: "stale" };
  if (overTokenLimit(inputs)) return { kind: "fresh", reason: "token-limit" };
  return { kind: "resume", handle: inputs.handle };
};
