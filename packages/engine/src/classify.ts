import type {
  ActionableItem,
  BlockedItem,
  BlockReason,
  Claim,
  ClaimedItem,
  LifecycleStage,
} from "@clanker-forge/contracts";
import { stagePriority } from "@clanker-forge/contracts";
import type { ObservedItem } from "./WorkSource";

export interface EligibleWork extends ActionableItem {
  readonly priorFailures: number;
}

export interface Classification {
  readonly eligible: ReadonlyArray<EligibleWork>;
  readonly claimed: ReadonlyArray<ClaimedItem>;
  readonly blocked: ReadonlyArray<BlockedItem>;
}

type Outcome =
  | { readonly kind: "eligible"; readonly stage: LifecycleStage; readonly priorFailures: number }
  | { readonly kind: "claimed"; readonly claim: Claim }
  | { readonly kind: "blocked"; readonly reason: BlockReason }
  | { readonly kind: "drop" };

const stageFor = (item: ObservedItem) => {
  if (item.pr?.review === "changes-requested") return "follow-up";
  if (item.pr?.review === "ready") return "verify";
  if (item.pr) return null;
  if (item.roles.includes("ready-for-agent")) return "implement";
  if (item.roles.includes("needs-triage")) return "triage";
  return null;
};

export const maxAttemptsPerStage = 3;

const failedAttempts = (item: ObservedItem, stage: LifecycleStage) =>
  item.attempts.filter((attempt) => attempt.stage === stage && attempt.outcome === "failed").length;

const classifyOne = (item: ObservedItem): Outcome => {
  if (item.roles.includes("wontfix")) return { kind: "drop" };
  if (item.claim) return { kind: "claimed", claim: item.claim };
  if (item.claimLabeled) return { kind: "drop" };
  if (item.roles.includes("needs-info")) return { kind: "blocked", reason: "needs-info" };
  if (item.roles.includes("ready-for-human")) return { kind: "blocked", reason: "ready-for-human" };
  const stage = stageFor(item);
  if (!stage) return { kind: "drop" };
  const failures = failedAttempts(item, stage);
  if (failures >= maxAttemptsPerStage) return { kind: "blocked", reason: "ready-for-human" };
  return { kind: "eligible", stage, priorFailures: failures };
};

const byStagePriority = (a: EligibleWork, b: EligibleWork) =>
  stagePriority.indexOf(a.stage) - stagePriority.indexOf(b.stage);

export const classify = (items: ReadonlyArray<ObservedItem>) => {
  const outcomes = items.map((item) => ({ item, outcome: classifyOne(item) }));
  const eligible = outcomes
    .flatMap(
      ({ item, outcome }): ReadonlyArray<EligibleWork> =>
        outcome.kind === "eligible"
          ? [{ id: item.id, title: item.title, stage: outcome.stage, priorFailures: outcome.priorFailures }]
          : [],
    )
    .sort(byStagePriority);
  const claimed = outcomes.flatMap(({ item, outcome }) =>
    outcome.kind === "claimed" ? [{ id: item.id, title: item.title, claim: outcome.claim }] : [],
  );
  const blocked = outcomes.flatMap(({ item, outcome }) =>
    outcome.kind === "blocked" ? [{ id: item.id, title: item.title, reason: outcome.reason }] : [],
  );
  return { eligible, claimed, blocked };
};
