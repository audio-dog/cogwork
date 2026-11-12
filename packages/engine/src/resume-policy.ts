import type { SessionKind, TokenUsage } from "@cogwork/contracts";
import * as Data from "effect/Data";

export type ResumeReason = "no-session" | "fresh-requested" | "worktree-recreated" | "stale" | "token-limit";

export type ResumeDecision = Data.TaggedEnum<{
  Resume: { readonly kind: "resume" };
  Fresh: { readonly kind: "fresh"; readonly reason: ResumeReason };
}>;
export const ResumeDecision = Data.taggedEnum<ResumeDecision>();

// Estimated usage can undercount the transcript, so only metered usage can gate the resume token cap.
export const meteredTotalTokens = (usage: TokenUsage | null | undefined) =>
  usage && !usage.estimated ? (usage.totalTokens ?? null) : null;

export interface ResumeInputs {
  readonly sessionKind: SessionKind | null;
  readonly handle: string | null;
  readonly lastRunStartedAtMillis: number | null;
  readonly lastRunTotalTokens: number | null;
  readonly now: number;
  readonly worktreeRecreated: boolean;
  readonly fresh: boolean;
  readonly maxAgeMillis: number | null;
  readonly maxTokens: number | null;
}

const resumable = (inputs: ResumeInputs) =>
  inputs.sessionKind === "owned-transcript" ||
  (inputs.sessionKind === "opaque-handle" && inputs.handle !== null);

const agedOut = (inputs: ResumeInputs) =>
  inputs.maxAgeMillis !== null &&
  inputs.lastRunStartedAtMillis !== null &&
  inputs.now - inputs.lastRunStartedAtMillis > inputs.maxAgeMillis;

const overTokenLimit = (inputs: ResumeInputs) =>
  inputs.maxTokens !== null &&
  inputs.lastRunTotalTokens !== null &&
  inputs.lastRunTotalTokens > inputs.maxTokens;

// The age and token caps guard an opaque handle, whose history the harness keeps
// out of reach and lets grow unbounded; an owned-transcript session compacts
// inside the provider runner's own loop, so the caps skip it.
export const decideResume = (inputs: ResumeInputs) => {
  if (!resumable(inputs)) return ResumeDecision.Fresh({ kind: "fresh", reason: "no-session" });
  if (inputs.fresh) return ResumeDecision.Fresh({ kind: "fresh", reason: "fresh-requested" });
  if (inputs.worktreeRecreated) {
    return ResumeDecision.Fresh({ kind: "fresh", reason: "worktree-recreated" });
  }
  if (inputs.sessionKind !== "opaque-handle") return ResumeDecision.Resume({ kind: "resume" });
  if (agedOut(inputs)) return ResumeDecision.Fresh({ kind: "fresh", reason: "stale" });
  if (overTokenLimit(inputs)) return ResumeDecision.Fresh({ kind: "fresh", reason: "token-limit" });
  return ResumeDecision.Resume({ kind: "resume" });
};
