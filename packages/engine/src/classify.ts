import type {
  ActionableItem,
  BlockedItem,
  Claim,
  ClaimedItem,
  ClassifiedItem,
  LifecycleStage,
  NeedsHumanItem,
  NeedsHumanReason,
  Priority,
  PrSummary,
  RunPlanWorkContextFacts,
  RunPlanWorkContextReference,
  SessionId,
} from "@cogwork/contracts";
import { byStageThenPriority } from "@cogwork/contracts";
import { type FollowUpContext, followUpContext, type ObservedPr, triggersFollowUp } from "./follow-up";
import type { ObservedItem } from "./issue-tracker";

export interface ResumeContext {
  readonly session: SessionId;
  readonly reason: "interrupted" | "crashed";
}

export interface EligibleWork extends ActionableItem {
  readonly priority: Priority;
  readonly priorFailures: number;
  readonly followUp?: FollowUpContext;
  readonly resume?: ResumeContext;
  readonly recovery?: ResumeContext["reason"];
  readonly followUpBranch?: string;
  readonly workContext: {
    readonly reference: RunPlanWorkContextReference;
    readonly facts: RunPlanWorkContextFacts;
  };
}

export interface Classification {
  readonly eligible: ReadonlyArray<EligibleWork>;
  readonly claimed: ReadonlyArray<ClaimedItem>;
  readonly blocked: ReadonlyArray<BlockedItem>;
  readonly needsHuman: ReadonlyArray<NeedsHumanItem>;
}

type Outcome =
  | { readonly kind: "eligible"; readonly stage: LifecycleStage }
  | { readonly kind: "claimed"; readonly claim: Claim }
  | { readonly kind: "blocked" }
  | { readonly kind: "needs-human"; readonly reason: NeedsHumanReason }
  | { readonly kind: "drop" };

const prSummaryOf = (pr: ObservedPr): PrSummary => ({
  number: pr.number,
  url: pr.url,
  checks: pr.checks,
  review: pr.review,
  baseDivergence: pr.baseDivergence,
  waitingSinceMillis: pr.waitingSinceMillis,
});

const prFields = (item: ObservedItem) => (item.pr ? { pr: prSummaryOf(item.pr) } : {});

const trackerUrl = (item: ObservedItem) => ({ url: item.url });

const prStage = (pr: ObservedPr) => {
  if (pr.followable === false) return null;
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

export const maxAttemptsPerStage = 3;

export const consecutiveFailures = (item: ObservedItem, stage: LifecycleStage) => {
  const forStage = item.attempts.filter((attempt) => attempt.stage === stage);
  const lastNonFailure = forStage.findLastIndex((attempt) => attempt.outcome !== "failed");
  return forStage.length - (lastNonFailure + 1);
};

const ownedByActor = (item: ObservedItem, allowlist: ReadonlyArray<string> | undefined) =>
  !allowlist || item.assignees.some((assignee) => allowlist.includes(assignee));

const classifyOne = (item: ObservedItem, allowlist: ReadonlyArray<string> | undefined): Outcome => {
  if (!ownedByActor(item, allowlist)) return { kind: "drop" };
  if (item.roles.includes("wontfix")) return { kind: "drop" };
  if (item.claim) return { kind: "claimed", claim: item.claim };
  if (item.claimLabeled) return { kind: "drop" };
  if (item.roles.includes("needs-info")) return { kind: "needs-human", reason: "needs-info" };
  if (item.roles.includes("ready-for-human")) return { kind: "needs-human", reason: "ready-for-human" };
  const stage = stageFor(item);
  if (!stage) return { kind: "drop" };
  if (stage === "implement" && item.openBlockers > 0) return { kind: "blocked" };
  const failures = consecutiveFailures(item, stage);
  if (failures >= maxAttemptsPerStage) return { kind: "needs-human", reason: "ready-for-human" };
  return { kind: "eligible", stage };
};

export const classifiedItemOf = (item: ObservedItem): ClassifiedItem | null => {
  const outcome = classifyOne(item, undefined);
  if (outcome.kind === "eligible") {
    return {
      _tag: "Eligible",
      id: item.id,
      title: item.title,
      stage: outcome.stage,
      ...trackerUrl(item),
      ...prFields(item),
    };
  }
  if (outcome.kind === "claimed") {
    return {
      _tag: "Claimed",
      id: item.id,
      title: item.title,
      claim: outcome.claim,
      ...trackerUrl(item),
      ...prFields(item),
    };
  }
  if (outcome.kind === "blocked") {
    return {
      _tag: "Blocked",
      id: item.id,
      title: item.title,
      openBlockers: item.openBlockers,
      ...trackerUrl(item),
      ...prFields(item),
    };
  }
  if (outcome.kind === "needs-human") {
    return {
      _tag: "NeedsHuman",
      id: item.id,
      title: item.title,
      reason: outcome.reason,
      proposal: item.proposal,
      url: item.url,
      ...prFields(item),
    };
  }
  return null;
};

export const eligibleWork = (item: ObservedItem, stage: LifecycleStage) => {
  const priorFailures = consecutiveFailures(item, stage);
  const followUp = stage === "follow-up" && item.pr ? followUpContext(item.pr) : undefined;
  return {
    id: item.id,
    title: item.title,
    ...trackerUrl(item),
    stage,
    priority: item.priority,
    priorFailures,
    ...(followUp ? { followUp } : {}),
    ...(stage === "follow-up" && item.pr?.followable !== false ? { followUpBranch: item.pr?.headRef } : {}),
    ...prFields(item),
    workContext: {
      reference: { workItem: item.id, url: item.url },
      facts: {
        roles: item.roles,
        assignees: item.assignees,
        openBlockers: item.openBlockers,
        claim: item.claim,
        priority: item.priority,
        pr: item.pr ? prSummaryOf(item.pr) : null,
      },
    },
  };
};

export const classify = (items: ReadonlyArray<ObservedItem>, allowlist?: ReadonlyArray<string>) => {
  const outcomes = items.map((item) => ({ item, outcome: classifyOne(item, allowlist) }));
  const eligible = outcomes
    .flatMap(({ item, outcome }) => (outcome.kind === "eligible" ? [eligibleWork(item, outcome.stage)] : []))
    .sort(byStageThenPriority);
  const claimed = outcomes.flatMap(({ item, outcome }) =>
    outcome.kind === "claimed"
      ? [{ id: item.id, title: item.title, claim: outcome.claim, ...trackerUrl(item), ...prFields(item) }]
      : [],
  );
  const blocked = outcomes.flatMap(({ item, outcome }) =>
    outcome.kind === "blocked"
      ? [
          {
            id: item.id,
            title: item.title,
            openBlockers: item.openBlockers,
            ...trackerUrl(item),
            ...prFields(item),
          },
        ]
      : [],
  );
  const needsHuman = outcomes.flatMap(({ item, outcome }) =>
    outcome.kind === "needs-human"
      ? [
          {
            id: item.id,
            title: item.title,
            reason: outcome.reason,
            proposal: item.proposal,
            url: item.url,
            ...prFields(item),
          },
        ]
      : [],
  );
  return { eligible, claimed, blocked, needsHuman };
};
