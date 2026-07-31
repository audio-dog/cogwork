import * as Schema from "effect/Schema";
import type { CheckState } from "./ci";

export type PrReview = "pending" | "changes-requested" | "ready";

export const FollowUpMarker = Schema.Struct({
  checks: Schema.Literals(["passing", "failing", "pending"]),
  humanCommentAtMillis: Schema.Finite,
  noProgress: Schema.Finite,
});

export type FollowUpMarker = typeof FollowUpMarker.Type;

export interface ObservedPr {
  readonly review: PrReview;
  readonly checks: CheckState;
  readonly latestHumanCommentAtMillis: number | null;
  readonly fresh: boolean;
  readonly followUp: FollowUpMarker | null;
}

export interface FollowUpContext {
  readonly checks: CheckState;
  readonly humanCommentAtMillis: number;
  readonly noProgress: number;
  readonly blocked: boolean;
  readonly fresh: boolean;
}

export const followUpNoProgressLimit = 3;

const humanCommentAt = (pr: ObservedPr) => pr.latestHumanCommentAtMillis ?? 0;

const hasNewHumanComment = (pr: ObservedPr) => humanCommentAt(pr) > (pr.followUp?.humanCommentAtMillis ?? 0);

export const triggersFollowUp = (pr: ObservedPr) =>
  pr.checks === "failing" || pr.review === "changes-requested" || hasNewHumanComment(pr);

const progressSince = (marker: FollowUpMarker, pr: ObservedPr) => {
  const checksTurnedGreen = pr.checks === "passing" && marker.checks !== "passing";
  const newHuman = humanCommentAt(pr) > marker.humanCommentAtMillis;
  return checksTurnedGreen || newHuman;
};

export const noProgressCount = (pr: ObservedPr) =>
  pr.followUp && !progressSince(pr.followUp, pr) ? pr.followUp.noProgress + 1 : 0;

export const followUpContext = (pr: ObservedPr): FollowUpContext => {
  const noProgress = noProgressCount(pr);
  return {
    checks: pr.checks,
    humanCommentAtMillis: humanCommentAt(pr),
    noProgress,
    blocked: noProgress >= followUpNoProgressLimit,
    fresh: pr.fresh,
  };
};
