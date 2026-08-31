import type { WorkItemId } from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import type { IssueTrackerService, ObservedItem, TrackerItem } from "./issue-tracker";
import type { RegisteredWorkspace } from "./projector";
import type { PrSignals, SourceControlProviderService } from "./source-control";

export const applyHandbackBarrier = (item: ObservedItem) => {
  const handback = item.handback;
  if (handback === null) return item;
  const attempts = item.attempts.filter((attempt) => attempt.atMillis > handback.atMillis);
  const pr = item.pr;
  if (!pr?.followUp) return { ...item, attempts };
  const markerWritten = item.attempts.some(
    (attempt) =>
      attempt.stage === "follow-up" &&
      (attempt.outcome === "succeeded" || attempt.outcome === "abandoned") &&
      attempt.atMillis > handback.atMillis,
  );
  return {
    ...item,
    attempts,
    pr: { ...pr, followUp: markerWritten ? pr.followUp : { ...pr.followUp, noProgress: 0 } },
  };
};

const composed = (item: TrackerItem, signals: ReadonlyMap<WorkItemId, PrSignals>): ObservedItem => {
  const pr = signals.get(item.id);
  return applyHandbackBarrier({
    id: item.id,
    title: item.title,
    url: item.url,
    roles: item.roles,
    assignees: item.assignees,
    claimLabeled: item.claimLabeled,
    claim: item.claim,
    claimedByUs: item.claimedByUs,
    attempts: item.attempts,
    handback: item.handback,
    openBlockers: item.openBlockers,
    proposal: item.proposal,
    priority: item.priority,
    pr: pr ? { ...pr, followUp: item.followUp } : null,
  });
};

// The reconcile poll's composition: the tracker yields items, the provider attaches each
// daemon-owned item's PR state, and the two become the `ObservedItem` classification consumes.
export const observeWorkspace = (tracker: IssueTrackerService, provider: SourceControlProviderService) =>
  Effect.fn("observeWorkspace")(function* (workspace: RegisteredWorkspace) {
    const items = yield* tracker.observe(workspace);
    const owned = items.flatMap((item) => (item.owned ? [{ id: item.id, title: item.title }] : []));
    const signals = yield* provider.observe(workspace, owned);
    return items.map((item) => composed(item, signals));
  });
