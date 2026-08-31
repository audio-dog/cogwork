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
import * as Data from "effect/Data";
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
  const stage = stageFor(item);
  if (!stage) return Outcome.Drop({});
  if (availability?.get(stage)?.available === false) return Outcome.Drop({});
  if (stage === "implement" && item.openBlockers > 0) return Outcome.Blocked({});
  const failures = consecutiveFailures(item, stage);
  if (failures >= maxAttemptsPerStage) return Outcome.NeedsHuman({ reason: "ready-for-human" });
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
        id: item.id,
        title: item.title,
        claim,
        ...trackerUrl(item),
        ...prFields(item),
      }) satisfies ClassifiedItem,
    Blocked: () =>
      ({
        _tag: "Blocked",
        id: item.id,
        title: item.title,
        openBlockers: item.openBlockers,
        ...trackerUrl(item),
        ...prFields(item),
      }) satisfies ClassifiedItem,
    NeedsHuman: ({ reason }) =>
      ({
        _tag: "NeedsHuman",
        id: item.id,
        title: item.title,
        reason,
        proposal: item.proposal,
        url: item.url,
        ...prFields(item),
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
  const classified = items.map((item) =>
    Outcome.$match(classifyOne(item, allowlist, availability), {
      Eligible: ({ stage }) => ({
        eligible: [eligibleWork(item, stage)],
        claimed: [],
        blocked: [],
        needsHuman: [],
      }),
      Claimed: ({ claim }) => ({
        eligible: [],
        claimed: [{ id: item.id, title: item.title, claim, ...trackerUrl(item), ...prFields(item) }],
        blocked: [],
        needsHuman: [],
      }),
      Blocked: () => ({
        eligible: [],
        claimed: [],
        blocked: [
          {
            id: item.id,
            title: item.title,
            openBlockers: item.openBlockers,
            ...trackerUrl(item),
            ...prFields(item),
          },
        ],
        needsHuman: [],
      }),
      NeedsHuman: ({ reason }) => ({
        eligible: [],
        claimed: [],
        blocked: [],
        needsHuman: [
          {
            id: item.id,
            title: item.title,
            reason,
            proposal: item.proposal,
            url: item.url,
            ...prFields(item),
          },
        ],
      }),
      Drop: () => ({ eligible: [], claimed: [], blocked: [], needsHuman: [] }),
    }),
  );
  const eligible = classified.flatMap(({ eligible }) => eligible).sort(byStageThenPriority);
  const claimed = classified.flatMap(({ claimed }) => claimed);
  const blocked = classified.flatMap(({ blocked }) => blocked);
  const needsHuman = classified.flatMap(({ needsHuman }) => needsHuman);
  return { eligible, claimed, blocked, needsHuman };
};
