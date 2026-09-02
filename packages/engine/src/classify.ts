import type {
  ActionableItem,
  BlockedItem,
  Claim,
  ClaimedItem,
  ClassifiedItem,
  LifecycleStage,
  NeedsHumanItem,
  NeedsHumanReason,
  OperationAvailability,
  Priority,
  PrSummary,
  RunPlanWorkContextFacts,
  RunPlanWorkContextReference,
  SessionId,
} from "@cogwork/contracts";
import { byStageThenPriority } from "@cogwork/contracts";
import * as Chunk from "effect/Chunk";
import * as Data from "effect/Data";
import {
  type FollowUpContext,
  followUpContext,
  isStalledFollowUp,
  type ObservedPr,
  triggersFollowUp,
} from "./follow-up";
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

declare const emptyOutcome: unique symbol;
type EmptyOutcome = { readonly [emptyOutcome]?: never };

type Outcome = Data.TaggedEnum<{
  Eligible: { readonly stage: LifecycleStage };
  Claimed: { readonly claim: Claim };
  Blocked: EmptyOutcome;
  NeedsHuman: { readonly reason: NeedsHumanReason };
  Drop: EmptyOutcome;
}>;

const Outcome = Data.taggedEnum<Outcome>();

interface ClassificationChunks {
  readonly eligible: Chunk.Chunk<EligibleWork>;
  readonly claimed: Chunk.Chunk<ClaimedItem>;
  readonly blocked: Chunk.Chunk<BlockedItem>;
  readonly needsHuman: Chunk.Chunk<NeedsHumanItem>;
}

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

const claimedItemOf = (item: ObservedItem, claim: Claim) => ({
  id: item.id,
  title: item.title,
  claim,
  ...trackerUrl(item),
  ...prFields(item),
});

const blockedItemOf = (item: ObservedItem) => ({
  id: item.id,
  title: item.title,
  openBlockers: item.openBlockers,
  ...trackerUrl(item),
  ...prFields(item),
});

const needsHumanItemOf = (item: ObservedItem, reason: NeedsHumanReason) => ({
  id: item.id,
  title: item.title,
  reason,
  proposal: item.proposal,
  url: item.url,
  ...prFields(item),
});

const prStage = (pr: ObservedPr) => {
  if (pr.draft || pr.followable === false) return null;
  if (triggersFollowUp(pr)) return "follow-up";
  if (pr.review === "ready") return "verify";
  return null;
};

export const observedStage = (item: ObservedItem) => {
  if (item.pr) return prStage(item.pr);
  if (item.roles.includes("ready-for-agent")) return "implement";
  if (item.roles.includes("needs-triage")) return "triage";
  return null;
};

export const maxAttemptsPerStage = 3;

export const consecutiveFailures = (item: ObservedItem, stage: LifecycleStage) => {
  const forStage = item.attempts.filter((attempt) => attempt.stage === stage);
  const lastNonFailure = forStage.findLastIndex((attempt) => attempt.outcome !== "failed");
  return forStage.length - (lastNonFailure + 1);
};

const ownedByActor = (item: ObservedItem, allowlist: ReadonlyArray<string> | undefined) =>
  !allowlist || item.assignees.some((assignee) => allowlist.includes(assignee));

const classifyOne = (
  item: ObservedItem,
  allowlist: ReadonlyArray<string> | undefined,
  availability: ReadonlyMap<LifecycleStage, OperationAvailability> | undefined,
): Outcome => {
  if (!ownedByActor(item, allowlist)) return Outcome.Drop({});
  if (item.roles.includes("wontfix")) return Outcome.Drop({});
  if (item.claim) return Outcome.Claimed({ claim: item.claim });
  if (item.claimLabeled) return Outcome.Drop({});
  if (item.roles.includes("needs-info")) return Outcome.NeedsHuman({ reason: "needs-info" });
  if (item.roles.includes("ready-for-human")) return Outcome.NeedsHuman({ reason: "ready-for-human" });
  const stage = observedStage(item);
  if (!stage) return Outcome.Drop({});
  if (stage === "implement" && item.openBlockers > 0) return Outcome.Blocked({});
  const failures = consecutiveFailures(item, stage);
  if (failures >= maxAttemptsPerStage) return Outcome.NeedsHuman({ reason: "ready-for-human" });
  const followUp = stage === "follow-up" && item.pr ? followUpContext(item.pr) : undefined;
  if (availability?.get(stage)?.available === false && !isStalledFollowUp(stage, followUp)) {
    return Outcome.Drop({});
  }
  return Outcome.Eligible({ stage });
};

export const classifiedItemOf = (item: ObservedItem) =>
  Outcome.$match(classifyOne(item, undefined, undefined), {
    Eligible: ({ stage }) =>
      ({
        _tag: "Eligible",
        id: item.id,
        title: item.title,
        stage,
        ...trackerUrl(item),
        ...prFields(item),
      }) satisfies ClassifiedItem,
    Claimed: ({ claim }) =>
      ({
        _tag: "Claimed",
        ...claimedItemOf(item, claim),
      }) satisfies ClassifiedItem,
    Blocked: () =>
      ({
        _tag: "Blocked",
        ...blockedItemOf(item),
      }) satisfies ClassifiedItem,
    NeedsHuman: ({ reason }) =>
      ({
        _tag: "NeedsHuman",
        ...needsHumanItemOf(item, reason),
      }) satisfies ClassifiedItem,
    Drop: () => null,
  });

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

export const classify = (
  items: ReadonlyArray<ObservedItem>,
  allowlist?: ReadonlyArray<string>,
  availability?: ReadonlyMap<LifecycleStage, OperationAvailability>,
) => {
  const classification = items.reduce<ClassificationChunks>(
    (current, item) =>
      Outcome.$match(classifyOne(item, allowlist, availability), {
        Eligible: ({ stage }) => ({
          eligible: Chunk.append(current.eligible, eligibleWork(item, stage)),
          claimed: current.claimed,
          blocked: current.blocked,
          needsHuman: current.needsHuman,
        }),
        Claimed: ({ claim }) => ({
          eligible: current.eligible,
          claimed: Chunk.append(current.claimed, claimedItemOf(item, claim)),
          blocked: current.blocked,
          needsHuman: current.needsHuman,
        }),
        Blocked: () => ({
          eligible: current.eligible,
          claimed: current.claimed,
          blocked: Chunk.append(current.blocked, blockedItemOf(item)),
          needsHuman: current.needsHuman,
        }),
        NeedsHuman: ({ reason }) => ({
          eligible: current.eligible,
          claimed: current.claimed,
          blocked: current.blocked,
          needsHuman: Chunk.append(current.needsHuman, needsHumanItemOf(item, reason)),
        }),
        Drop: () => current,
      }),
    {
      eligible: Chunk.empty(),
      claimed: Chunk.empty(),
      blocked: Chunk.empty(),
      needsHuman: Chunk.empty(),
    },
  );
  return {
    eligible: Chunk.toArray(classification.eligible).toSorted(byStageThenPriority),
    claimed: Chunk.toReadonlyArray(classification.claimed),
    blocked: Chunk.toReadonlyArray(classification.blocked),
    needsHuman: Chunk.toReadonlyArray(classification.needsHuman),
  };
};
