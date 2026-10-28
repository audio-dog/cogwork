import { IssueTrackerError, type WorkItemId } from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";
import { fold } from "./coordination";
import type { IssueTrackerService, ObservedItem, TrackerItem } from "./issue-tracker";
import type { RegisteredWorkspace } from "./projector";
import type { PrSignals, SourceControlProviderService } from "./source-control";

export const reconcilePollPhaseDuration = Metric.timer("cogwork_reconcile_poll_phase_duration", {
  description: "Time spent in one phase of a workspace reconcile poll.",
});

const implicitSourceControls: Readonly<Record<string, string>> = { github: "github" };

export const reconcilePollAttributes = (workspace: RegisteredWorkspace) => ({
  workspace: workspace.config.name,
  issue_tracker: workspace.config.issueTracker.type,
  source_control:
    workspace.config.sourceControl?.type ??
    implicitSourceControls[workspace.config.issueTracker.type] ??
    "none",
});

export const reconcilePhaseDuration = (
  workspace: RegisteredWorkspace,
  phase: "tracker" | "source-control" | "availability",
) => Metric.withAttributes(reconcilePollPhaseDuration, { ...reconcilePollAttributes(workspace), phase });

const composed = (item: TrackerItem, signals: ReadonlyMap<WorkItemId, PrSignals>): ObservedItem => {
  const pr = signals.get(item.id);
  const coordination =
    item.coordination ??
    fold(
      {
        claim: item.claim,
        attempts: item.attempts,
        handbacks: item.handback ? [{ ...item.handback, note: item.handback.note ?? null }] : [],
        parks: [],
        revision: null,
      },
      "cogwork",
    );
  const observed: ObservedItem = {
    id: item.id,
    title: item.title,
    url: item.url,
    roles: item.roles,
    assignees: item.assignees,
    claimHeld: item.claimHeld,
    claim: item.claim,
    claimedByUs: item.claimedByUs,
    attempts: item.attempts,
    handback: item.handback,
    openBlockers: item.openBlockers,
    proposal: item.proposal,
    priority: item.priority,
    pr: pr ? { ...pr, followUp: item.followUp } : null,
    coordination,
  };
  const followUp = observed.pr?.followUp;
  const barrier = coordination.barrierAtMillis;
  const markerWritten = observed.attempts.some(
    (attempt) =>
      attempt.atMillis > barrier && (attempt.outcome === "succeeded" || attempt.outcome === "abandoned"),
  );
  if (!followUp || barrier === 0 || markerWritten) return observed;
  return { ...observed, pr: { ...observed.pr, followUp: { ...followUp, noProgress: 0 } } };
};

export const observeWorkspace = (tracker: IssueTrackerService, provider: SourceControlProviderService) =>
  Effect.fn("observeWorkspace")(function* (workspace: RegisteredWorkspace) {
    const trackerConnectionId = workspace.config.issueTracker.connectionId;
    const items = yield* tracker.observe(workspace).pipe(
      Effect.trackDuration(reconcilePhaseDuration(workspace, "tracker")),
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
    const workItems = items.map(({ id, title }) => ({ id, title }));
    const sourceControlConnectionId =
      workspace.config.sourceControl?.connectionId ??
      (workspace.config.issueTracker.type === "github"
        ? workspace.config.issueTracker.connectionId
        : undefined);
    const signals = yield* provider.observe(workspace, workItems).pipe(
      Effect.trackDuration(reconcilePhaseDuration(workspace, "source-control")),
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
