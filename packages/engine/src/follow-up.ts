import type { FollowUpResultOutcome, LifecycleStage } from "@cogwork/contracts";
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
  attemptAtMillis: Schema.optional(Schema.Finite),
  latestFailingCheckAtMillis: Schema.optional(Schema.Finite),
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
  readonly latestFailingCheckAtMillis?: number | null;
  readonly observedAtMillis?: number;
  readonly fresh: boolean;
  readonly baseDivergence: BaseDivergence;
  readonly waitingSinceMillis: number;
  readonly headRef: string;
  readonly followable: boolean;
  readonly draft: boolean;
  readonly followUp: FollowUpMarker | null;
}

export interface FollowUpContext {
  readonly previousMarker: FollowUpMarker | null;
  readonly checks: CheckState;
  readonly humanCommentAtMillis: number;
  readonly botTriggerAtMillis: number;
  readonly latestFailingCheckAtMillis?: number;
  readonly noProgress: number;
  readonly stalled: boolean;
  readonly fresh: boolean;
  readonly baseDivergence: BaseDivergence;
}

export const followUpNoProgressLimit = 3;

export const isStalledFollowUp = (stage: LifecycleStage, context: FollowUpContext | undefined) =>
  stage === "follow-up" && context?.stalled === true;

const humanCommentAt = (pr: ObservedPr) => pr.latestHumanCommentAtMillis ?? 0;

const botTriggerAt = (pr: ObservedPr) => pr.latestBotTriggerAtMillis ?? 0;

const hasNewHumanComment = (pr: ObservedPr) => humanCommentAt(pr) > (pr.followUp?.humanCommentAtMillis ?? 0);

// Kept out of `progressSince`: a bot comment wakes a follow-up but is never progress on its own.
// What settles the count is what the round then does about it — see `noProgressAfterRound` — so a
// bot exchange that keeps producing real fixes keeps going, and one that produces nothing hands off.
const hasNewBotTrigger = (pr: ObservedPr) => botTriggerAt(pr) > (pr.followUp?.botTriggerAtMillis ?? 0);

export type FollowUpTrigger = {
  readonly kind: "human-feedback" | "trusted-bot-finding" | "failing-check" | "merge-conflict";
  readonly atMillis: number;
};

interface TriggerInput {
  readonly pr: ObservedPr;
  readonly attemptAtMillis: number;
}

const conflictTriggerAtMillis = ({ pr, attemptAtMillis }: TriggerInput) => {
  const conflictStartedAfterAttempt =
    pr.baseDivergence === "conflict" &&
    pr.followUp?.attemptAtMillis === attemptAtMillis &&
    pr.followUp.baseDivergence !== "conflict";
  return conflictStartedAfterAttempt ? (pr.observedAtMillis ?? 0) : 0;
};

const triggerSources = [
  {
    kind: "human-feedback",
    atMillis: ({ pr }: TriggerInput) => humanCommentAt(pr),
    thresholdAtMillis: ({ attemptAtMillis }: TriggerInput) => attemptAtMillis,
  },
  {
    kind: "trusted-bot-finding",
    atMillis: ({ pr }: TriggerInput) => botTriggerAt(pr),
    thresholdAtMillis: ({ attemptAtMillis }: TriggerInput) => attemptAtMillis,
  },
  {
    kind: "failing-check",
    atMillis: ({ pr }: TriggerInput) => pr.latestFailingCheckAtMillis ?? 0,
    thresholdAtMillis: ({ pr }: TriggerInput) =>
      pr.followUp?.latestFailingCheckAtMillis ??
      (pr.followUp?.checks === "failing" ? Number.POSITIVE_INFINITY : 0),
  },
  {
    kind: "merge-conflict",
    atMillis: conflictTriggerAtMillis,
    thresholdAtMillis: () => 0,
  },
] as const;

export const followUpTriggerAfter = (pr: ObservedPr, atMillis: number): FollowUpTrigger | null => {
  const input = { pr, attemptAtMillis: atMillis };
  return (
    triggerSources
      .map(({ kind, atMillis, thresholdAtMillis }) => ({
        kind,
        atMillis: atMillis(input),
        thresholdAtMillis: thresholdAtMillis(input),
      }))
      .filter((candidate) => candidate.atMillis > candidate.thresholdAtMillis)
      .toSorted((left, right) => right.atMillis - left.atMillis)
      .map(({ kind, atMillis }) => ({ kind, atMillis }))
      .at(0) ?? null
  );
};

export const triggersFollowUp = (pr: ObservedPr) =>
  pr.checks === "failing" ||
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

export const noProgressAfterRound = (context: FollowUpContext, outcome: FollowUpResultOutcome) =>
  outcome === "pushed" ? 0 : context.noProgress;

export const followUpContext = (pr: ObservedPr): FollowUpContext => {
  const noProgress = noProgressCount(pr);
  return {
    previousMarker: pr.followUp,
    checks: pr.checks,
    humanCommentAtMillis: humanCommentAt(pr),
    botTriggerAtMillis: botTriggerAt(pr),
    latestFailingCheckAtMillis: pr.latestFailingCheckAtMillis ?? 0,
    noProgress,
    stalled: noProgress >= followUpNoProgressLimit,
    fresh: pr.fresh,
    baseDivergence: pr.baseDivergence,
  };
};
