import type {
  ActionableItem,
  BlockedItem,
  BranchName,
  Claim,
  ClaimedItem,
  ClassifiedItem,
  LifecycleStage,
  NeedsHumanItem,
  NeedsHumanReason,
  OperationAvailability,
  Priority,
  PrSummary,
  ReadyToMergeItem,
  RunPlanWorkContextFacts,
  RunPlanWorkContextProse,
  RunPlanWorkContextReference,
  SessionId,
} from "@cogwork/contracts";
import { BranchName as BranchNameSchema, byStageThenPriority, codingOperation } from "@cogwork/contracts";
import * as Chunk from "effect/Chunk";
import * as Data from "effect/Data";
import { fold, maxAttemptsPerOperation } from "./coordination";
import {
  type FollowUpContext,
  followUpContext,
  followUpTriggerAfter,
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
  readonly followUpBranch?: BranchName;
  readonly workContext: {
    readonly reference: RunPlanWorkContextReference;
    readonly facts: RunPlanWorkContextFacts;
  };
}

export type AdmittedWork = Omit<EligibleWork, "workContext"> & {
  readonly workContext: EligibleWork["workContext"] & {
    readonly prose: RunPlanWorkContextProse;
  };
};

export interface Classification {
  readonly eligible: ReadonlyArray<EligibleWork>;
  readonly claimed: ReadonlyArray<ClaimedItem>;
  readonly blocked: ReadonlyArray<BlockedItem>;
  readonly needsHuman: ReadonlyArray<NeedsHumanItem>;
  readonly readyToMerge: ReadonlyArray<ReadyToMergeItem>;
}

const followUpBranchFor = (item: ObservedItem, stage: LifecycleStage) => {
  const branch = item.pr?.headRef;
  const hasFollowUpBranch = stage === "follow-up" && item.pr?.followable !== false && branch !== undefined;
  return hasFollowUpBranch ? BranchNameSchema.make(branch) : undefined;
};

declare const emptyOutcome: unique symbol;
type EmptyOutcome = { readonly [emptyOutcome]?: never };

type Outcome = Data.TaggedEnum<{
  Eligible: { readonly stage: LifecycleStage };
  Claimed: { readonly claim: Claim };
  Blocked: EmptyOutcome;
  NeedsHuman: { readonly reason: NeedsHumanReason };
  ReadyToMerge: { readonly pr: ObservedPr };
  Drop: EmptyOutcome;
}>;

const Outcome = Data.taggedEnum<Outcome>();

interface ClassificationChunks {
  readonly eligible: Chunk.Chunk<EligibleWork>;
  readonly claimed: Chunk.Chunk<ClaimedItem>;
  readonly blocked: Chunk.Chunk<BlockedItem>;
  readonly needsHuman: Chunk.Chunk<NeedsHumanItem>;
  readonly readyToMerge: Chunk.Chunk<ReadyToMergeItem>;
}

const replaceClassificationChunk = <Key extends keyof ClassificationChunks>(
  current: ClassificationChunks,
  key: Key,
  chunk: ClassificationChunks[Key],
) => Object.assign({}, current, { [key]: chunk });

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

const readyToMergeItemOf = (item: ObservedItem, pr: ObservedPr) => ({
  id: item.id,
  title: item.title,
  ...trackerUrl(item),
  pr: prSummaryOf(pr),
});

const prStage = (pr: ObservedPr) => {
  if (pr.draft || pr.followable === false) return null;
  if (triggersFollowUp(pr)) return "follow-up";
  return null;
};

const readyToMergePrOf = (item: ObservedItem) => {
  const pr = item.pr;
  if (!pr || pr.draft) return null;
  if (triggersFollowUp(pr) || pr.review !== "ready") return null;
  return pr;
};

export const observedStage = (item: ObservedItem) => {
  if (item.pr) return prStage(item.pr);
  if (item.roles.includes("ready-for-agent")) return "implement";
  if (item.roles.includes("needs-triage")) return "triage";
  return null;
};

export { maxAttemptsPerOperation };

const coordinationViewOf = (item: ObservedItem) =>
  item.coordination ??
  fold(
    {
      claim: item.claim,
      attempts: item.attempts,
      handbacks: item.handback ? [{ ...item.handback, note: null }] : [],
      parks: [],
      revision: null,
    },
    "cogwork",
  );

export const consecutiveFailures = (item: ObservedItem, key: ReturnType<typeof codingOperation>) =>
  coordinationViewOf(item).counters(key).consecutiveFailures;

const newestFailedFollowUpAttempt = (item: ObservedItem) => {
  const barrierAtMillis = coordinationViewOf(item).barrierAtMillis;
  return item.attempts.findLast(
    (attempt) =>
      attempt.atMillis > barrierAtMillis &&
      attempt.operation.workflow === "coding" &&
      attempt.operation.operation === "follow-up" &&
      (attempt.outcome === "failed" || attempt.outcome === "abandoned"),
  );
};

const pendingFollowUpTrigger = (item: ObservedItem) => {
  if (!item.followUpTrigger) return null;
  const barrierAtMillis = coordinationViewOf(item).barrierAtMillis;
  const triggerConsumed = item.attempts.some(
    (attempt) =>
      attempt.atMillis > barrierAtMillis &&
      attempt.operation.workflow === "coding" &&
      attempt.operation.operation === "follow-up",
  );
  return triggerConsumed ? null : item.followUpTrigger;
};

export const failedFollowUpReopen = (item: ObservedItem) => {
  const isFailedFollowUpPark =
    item.pr &&
    !item.pr.draft &&
    item.pr.followable !== false &&
    !item.roles.includes("needs-info") &&
    item.roles.includes("ready-for-human");
  if (!isFailedFollowUpPark) return null;
  const attempt = newestFailedFollowUpAttempt(item);
  if (!attempt) return null;
  const engineHandoffAtMillis = item.engineHandoffAtMillis ?? 0;
  const handoffOwnsPark =
    engineHandoffAtMillis >= attempt.atMillis &&
    engineHandoffAtMillis > coordinationViewOf(item).barrierAtMillis;
  if (!handoffOwnsPark) return null;
  return followUpTriggerAfter(item.pr, attempt.atMillis);
};

const latestFailureReason = (item: ObservedItem, key: ReturnType<typeof codingOperation>) => {
  const barrierAtMillis = coordinationViewOf(item).barrierAtMillis;
  const latest = item.attempts
    .filter(
      (attempt) =>
        attempt.atMillis > barrierAtMillis &&
        attempt.operation.workflow === key.workflow &&
        attempt.operation.operation === key.operation,
    )
    .at(-1);
  return latest?.outcome === "failed" ? (latest.reason ?? null) : null;
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
  if (item.claimHeld) return Outcome.Drop({});
  if (item.roles.includes("needs-info")) return Outcome.NeedsHuman({ reason: "needs-info" });
  const reopen = failedFollowUpReopen(item);
  if (item.roles.includes("ready-for-human") && !reopen) {
    return Outcome.NeedsHuman({ reason: "ready-for-human" });
  }
  const readyToMergePr = readyToMergePrOf(item);
  if (readyToMergePr) return Outcome.ReadyToMerge({ pr: readyToMergePr });
  const stage = observedStage(item);
  if (!stage) return Outcome.Drop({});
  if (stage === "implement" && item.openBlockers > 0) return Outcome.Blocked({});
  if (!reopen && coordinationViewOf(item).counters(codingOperation(stage)).exhausted) {
    return Outcome.NeedsHuman({ reason: "ready-for-human" });
  }
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
    ReadyToMerge: ({ pr }) =>
      ({
        _tag: "ReadyToMerge",
        ...readyToMergeItemOf(item, pr),
      }) satisfies ClassifiedItem,
    Drop: () => null,
  });

export const eligibleWork = (item: ObservedItem, stage: LifecycleStage) => {
  const operation = codingOperation(stage);
  const reopen = failedFollowUpReopen(item);
  const trigger = reopen ?? pendingFollowUpTrigger(item);
  const priorFailures = reopen ? 0 : coordinationViewOf(item).counters(operation).consecutiveFailures;
  const followUp = stage === "follow-up" && item.pr ? followUpContext(item.pr) : undefined;
  const followUpBranch = followUpBranchFor(item, stage);
  return {
    id: item.id,
    title: item.title,
    ...trackerUrl(item),
    stage,
    priority: item.priority,
    priorFailures,
    ...(followUp ? { followUp } : {}),
    ...(followUpBranch ? { followUpBranch } : {}),
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
        failureReason: reopen ? null : latestFailureReason(item, operation),
        followUpTrigger: trigger,
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
        Eligible: ({ stage }) =>
          replaceClassificationChunk(
            current,
            "eligible",
            Chunk.append(current.eligible, eligibleWork(item, stage)),
          ),
        Claimed: ({ claim }) =>
          replaceClassificationChunk(
            current,
            "claimed",
            Chunk.append(current.claimed, claimedItemOf(item, claim)),
          ),
        Blocked: () =>
          replaceClassificationChunk(current, "blocked", Chunk.append(current.blocked, blockedItemOf(item))),
        NeedsHuman: ({ reason }) =>
          replaceClassificationChunk(
            current,
            "needsHuman",
            Chunk.append(current.needsHuman, needsHumanItemOf(item, reason)),
          ),
        ReadyToMerge: ({ pr }) =>
          replaceClassificationChunk(
            current,
            "readyToMerge",
            Chunk.append(current.readyToMerge, readyToMergeItemOf(item, pr)),
          ),
        Drop: () => current,
      }),
    {
      eligible: Chunk.empty(),
      claimed: Chunk.empty(),
      blocked: Chunk.empty(),
      needsHuman: Chunk.empty(),
      readyToMerge: Chunk.empty(),
    },
  );
  return {
    eligible: Chunk.toArray(classification.eligible).toSorted(byStageThenPriority),
    claimed: Chunk.toReadonlyArray(classification.claimed),
    blocked: Chunk.toReadonlyArray(classification.blocked),
    needsHuman: Chunk.toReadonlyArray(classification.needsHuman),
    readyToMerge: Chunk.toReadonlyArray(classification.readyToMerge),
  };
};
