import { IssueTrackerError, type WorkItemId } from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import type { IssueTrackerService, ObservedItem, TrackerItem } from "./issue-tracker";
import type { RegisteredWorkspace } from "./projector";
import type { PrSignals, SourceControlProviderService } from "./source-control";

const composed = (item: TrackerItem, signals: ReadonlyMap<WorkItemId, PrSignals>): ObservedItem => {
  const pr = signals.get(item.id);
  return {
    id: item.id,
    title: item.title,
    url: item.url,
    roles: item.roles,
    assignees: item.assignees,
    claimLabeled: item.claimLabeled,
    claim: item.claim,
    claimedByUs: item.claimedByUs,
    attempts: item.attempts,
    openBlockers: item.openBlockers,
    proposal: item.proposal,
    priority: item.priority,
    pr: pr ? { ...pr, followUp: item.followUp } : null,
  };
};

// The reconcile poll's composition: the tracker yields items, the provider attaches each
// daemon-owned item's PR state, and the two become the `ObservedItem` classification consumes.
export const observeWorkspace = (tracker: IssueTrackerService, provider: SourceControlProviderService) =>
  Effect.fn("observeWorkspace")(function* (workspace: RegisteredWorkspace) {
    const trackerConnectionId = workspace.config.issueTracker.connectionId;
    const items = yield* tracker.observe(workspace).pipe(
      Effect.mapError(
        (error) =>
          new IssueTrackerError({
            reason: error.reason,
            message: error.message,
            ...(error.retryAfterMillis === undefined ? {} : { retryAfterMillis: error.retryAfterMillis }),
            ...(trackerConnectionId === "unbound" ? {} : { connectionId: trackerConnectionId }),
          }),
      ),
    );
    const owned = items.flatMap((item) => (item.owned ? [{ id: item.id, title: item.title }] : []));
    const sourceControlConnectionId =
      workspace.config.sourceControl?.connectionId ??
      (workspace.config.issueTracker.type === "github"
        ? workspace.config.issueTracker.connectionId
        : undefined);
    const signals = yield* provider.observe(workspace, owned).pipe(
      Effect.mapError(
        (error) =>
          new IssueTrackerError({
            reason: error.reason,
            message: error.message,
            ...(error.retryAfterMillis === undefined ? {} : { retryAfterMillis: error.retryAfterMillis }),
            ...(sourceControlConnectionId === undefined || sourceControlConnectionId === "unbound"
              ? {}
              : { connectionId: sourceControlConnectionId }),
          }),
      ),
    );
    return items.map((item) => composed(item, signals));
  });
