import type {
  ActionableItem,
  Claim,
  ClaimedItem,
  LifecycleStage,
  NeedsHumanItem,
  NeedsHumanReason,
} from "@clanker-forge/contracts";
import { stagePriority } from "@clanker-forge/contracts";
import { type FollowUpContext, followUpContext, type ObservedPr, triggersFollowUp } from "./followUp";
import type { ObservedItem } from "./WorkSource";

export interface EligibleWork extends ActionableItem {
  readonly priorFailures: number;
  readonly followUp?: FollowUpContext;
}

export interface Classification {
  readonly eligible: ReadonlyArray<EligibleWork>;
  readonly claimed: ReadonlyArray<ClaimedItem>;
  readonly needsHuman: ReadonlyArray<NeedsHumanItem>;
}

type Outcome =
  | {
      readonly kind: "eligible";
      readonly stage: LifecycleStage;
      readonly priorFailures: number;
      readonly followUp?: FollowUpContext;
    }
  | { readonly kind: "claimed"; readonly claim: Claim }
  | { readonly kind: "needs-human"; readonly reason: NeedsHumanReason }
  | { readonly kind: "drop" };

const prStage = (pr: ObservedPr) => {
  if (triggersFollowUp(pr)) return "follow-up";
  if (pr.review === "ready") return "verify";
  return null;
};

const stageFor = (item: ObservedItem) => {
  if (item.pr) return prStage(item.pr);
  if (item.roles.includes("ready-for-agent")) return "implement";
  if (item.roles.includes("needs-triage")) return "triage";
  return null;
};

export const observedStage = (item: ObservedItem) => item.claim?.stage ?? stageFor(item);

export const blockRoleFor = (stage: LifecycleStage) => {
  if (stage === "implement") return "ready-for-agent" as const;
  if (stage === "triage") return "needs-triage" as const;
  return null;
};

export const maxAttemptsPerStage = 3;

export const consecutiveFailures = (item: ObservedItem, stage: LifecycleStage) => {
  const forStage = item.attempts.filter((attempt) => attempt.stage === stage);
  const lastNonFailure = forStage.findLastIndex((attempt) => attempt.outcome !== "failed");
  return forStage.length - (lastNonFailure + 1);
};

const classifyOne = (item: ObservedItem): Outcome => {
  if (item.roles.includes("wontfix")) return { kind: "drop" };
  if (item.claim) return { kind: "claimed", claim: item.claim };
  if (item.claimLabeled) return { kind: "drop" };
  if (item.roles.includes("needs-info")) return { kind: "needs-human", reason: "needs-info" };
  if (item.roles.includes("ready-for-human")) return { kind: "needs-human", reason: "ready-for-human" };
  const stage = stageFor(item);
  if (!stage) return { kind: "drop" };
  const failures = consecutiveFailures(item, stage);
  if (failures >= maxAttemptsPerStage) return { kind: "needs-human", reason: "ready-for-human" };
  const followUp = stage === "follow-up" && item.pr ? followUpContext(item.pr) : undefined;
  return { kind: "eligible", stage, priorFailures: failures, followUp };
};

const byStagePriority = (a: EligibleWork, b: EligibleWork) =>
  stagePriority.indexOf(a.stage) - stagePriority.indexOf(b.stage);

const toEligible = (item: ObservedItem, outcome: Extract<Outcome, { readonly kind: "eligible" }>) => ({
  id: item.id,
  title: item.title,
  stage: outcome.stage,
  priorFailures: outcome.priorFailures,
  ...(outcome.followUp ? { followUp: outcome.followUp } : {}),
});

export const classify = (items: ReadonlyArray<ObservedItem>) => {
  const outcomes = items.map((item) => ({ item, outcome: classifyOne(item) }));
  const eligible = outcomes
    .flatMap(({ item, outcome }) => (outcome.kind === "eligible" ? [toEligible(item, outcome)] : []))
    .sort(byStagePriority);
  const claimed = outcomes.flatMap(({ item, outcome }) =>
    outcome.kind === "claimed" ? [{ id: item.id, title: item.title, claim: outcome.claim }] : [],
  );
  const needsHuman = outcomes.flatMap(({ item, outcome }) =>
    outcome.kind === "needs-human" ? [{ id: item.id, title: item.title, reason: outcome.reason }] : [],
  );
  return { eligible, claimed, needsHuman };
};
