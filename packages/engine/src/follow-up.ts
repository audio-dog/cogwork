import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { CheckState } from "./ci";

export type PrReview = "pending" | "changes-requested" | "ready";

export type BaseDivergence = "conflict" | "clean" | "none";

export const FollowUpMarker = Schema.Struct({
  checks: Schema.Literals(["passing", "failing", "pending"]),
  humanCommentAtMillis: Schema.Finite,
  noProgress: Schema.Finite,
  baseDivergence: Schema.Literals(["conflict", "clean", "none"]),
  // Optional-with-default so markers persisted without a bot-trigger time still decode (as 0).
  botTriggerAtMillis: Schema.Finite.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
});

export type FollowUpMarker = typeof FollowUpMarker.Type;

export interface ObservedPr {
  readonly number: number;
  readonly url: string;
  readonly review: PrReview;
  readonly checks: CheckState;
  readonly latestHumanCommentAtMillis: number | null;
  readonly latestBotTriggerAtMillis: number | null;
  readonly fresh: boolean;
  readonly baseDivergence: BaseDivergence;
  readonly waitingSinceMillis: number;
  readonly followUp: FollowUpMarker | null;
}

export interface FollowUpContext {
  readonly checks: CheckState;
  readonly humanCommentAtMillis: number;
  readonly botTriggerAtMillis: number;
  readonly noProgress: number;
  readonly stalled: boolean;
  readonly fresh: boolean;
  readonly baseDivergence: BaseDivergence;
}

export const followUpNoProgressLimit = 3;

const humanCommentAt = (pr: ObservedPr) => pr.latestHumanCommentAtMillis ?? 0;

const botTriggerAt = (pr: ObservedPr) => pr.latestBotTriggerAtMillis ?? 0;

const hasNewHumanComment = (pr: ObservedPr) => humanCommentAt(pr) > (pr.followUp?.humanCommentAtMillis ?? 0);

// Kept out of `progressSince`: a bot round wakes a follow-up but is never progress, so pure bot
// back-and-forth still reaches the no-progress limit and hands off to a human.
const hasNewBotTrigger = (pr: ObservedPr) => botTriggerAt(pr) > (pr.followUp?.botTriggerAtMillis ?? 0);

export const triggersFollowUp = (pr: ObservedPr) =>
  pr.checks === "failing" ||
  pr.review === "changes-requested" ||
  pr.baseDivergence === "conflict" ||
  hasNewHumanComment(pr) ||
  hasNewBotTrigger(pr);

const conflictResolved = (marker: FollowUpMarker, pr: ObservedPr) =>
  marker.baseDivergence === "conflict" && pr.baseDivergence !== "conflict";

const progressSince = (marker: FollowUpMarker, pr: ObservedPr) => {
  const checksTurnedGreen = pr.checks === "passing" && marker.checks !== "passing";
  const newHuman = humanCommentAt(pr) > marker.humanCommentAtMillis;
  return checksTurnedGreen || newHuman || conflictResolved(marker, pr);
};

export const noProgressCount = (pr: ObservedPr) =>
  pr.followUp && !progressSince(pr.followUp, pr) ? pr.followUp.noProgress + 1 : 0;

export const followUpContext = (pr: ObservedPr): FollowUpContext => {
  const noProgress = noProgressCount(pr);
  return {
    checks: pr.checks,
    humanCommentAtMillis: humanCommentAt(pr),
    botTriggerAtMillis: botTriggerAt(pr),
    noProgress,
    stalled: noProgress >= followUpNoProgressLimit,
    fresh: pr.fresh,
    baseDivergence: pr.baseDivergence,
  };
};
