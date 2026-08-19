import {
  type AttemptRecord,
  type Claim,
  IssueTrackerError,
  type LifecycleStage,
  type TriageRole,
  type WorkItemId,
} from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { FollowUpMarker, ObservedPr } from "./follow-up";
import type { RegisteredWorkspace } from "./projector";

export type { BaseDivergence, FollowUpMarker, ObservedPr, PrReview } from "./follow-up";
export { IssueTrackerError };

export type ClaimRequest = Omit<Claim, "by">;

interface ObservedItemBase {
  readonly id: WorkItemId;
  readonly title: string;
  readonly url: string;
  readonly roles: ReadonlyArray<TriageRole>;
  readonly assignees: ReadonlyArray<string>;
  readonly claimLabeled: boolean;
  readonly claim: Claim | null;
  readonly claimedByUs: boolean;
  readonly attempts: ReadonlyArray<AttemptRecord>;
  readonly openBlockers: number;
  readonly proposal: string | null;
}

// What an issue tracker observes on its own: backlog state plus the coordination it owns. It no
// longer reads pull requests — the source control provider does, and the reconcile poll merges the
// two into an `ObservedItem`. `owned` (daemon-owned coordination) and `followUp` are the two signals
// the merge needs from the tracker to gate and assemble PR state.
export interface TrackerItem extends ObservedItemBase {
  readonly owned: boolean;
  readonly followUp: FollowUpMarker | null;
}

export interface ObservedItem extends ObservedItemBase {
  readonly pr: ObservedPr | null;
}

export interface RoleChanges {
  readonly add: ReadonlyArray<TriageRole>;
  readonly remove: ReadonlyArray<TriageRole>;
}

export interface TriagedOutcome {
  readonly role: TriageRole;
  readonly proposal: string;
  readonly atMillis: number;
}

export interface ImplementedOutcome {
  readonly atMillis: number;
}

export interface FollowedUpOutcome {
  readonly marker: FollowUpMarker;
  readonly atMillis: number;
}

export interface AttemptFailedOutcome {
  readonly stage: LifecycleStage;
  readonly atMillis: number;
  readonly reason?: string;
}

export interface HandOffOutcome {
  readonly stage: LifecycleStage;
  readonly note?: string;
}

export interface StalledOutcome {
  readonly marker: FollowUpMarker;
  readonly atMillis: number;
  readonly detail: string;
}

export interface ReclassifyOutcome {
  readonly changes: RoleChanges;
  readonly note?: string;
}

const noAdapter = (workspace: RegisteredWorkspace) =>
  new IssueTrackerError({
    reason: "unavailable",
    message: `no work source adapter configured for ${workspace.config.name}`,
  });

const hasRemoteSource = (workspace: RegisteredWorkspace) => {
  const { type, team, repo } = workspace.config.issueTracker;
  return type === "linear" ? Boolean(team) : Boolean(repo);
};

const failWhenRemote = Effect.fn("IssueTracker.guard")(function* (workspace: RegisteredWorkspace) {
  if (hasRemoteSource(workspace)) {
    return yield* noAdapter(workspace);
  }
  return yield* Effect.void;
});

const observeEmpty = Effect.fn("IssueTracker.observe")(function* (workspace: RegisteredWorkspace) {
  if (hasRemoteSource(workspace)) {
    return yield* noAdapter(workspace);
  }
  return [] as ReadonlyArray<TrackerItem>;
});

export const makeEmpty = Effect.succeed({
  rateLimitScope: (_workspace: RegisteredWorkspace): string | null => null,
  observe: observeEmpty,
  claim: (workspace: RegisteredWorkspace, _itemId: WorkItemId, _claim: ClaimRequest) =>
    failWhenRemote(workspace),
  release: (workspace: RegisteredWorkspace, _itemId: WorkItemId) => failWhenRemote(workspace),
  note: (workspace: RegisteredWorkspace, _itemId: WorkItemId, _detail: string) => failWhenRemote(workspace),
  triaged: (workspace: RegisteredWorkspace, _itemId: WorkItemId, _outcome: TriagedOutcome) =>
    failWhenRemote(workspace),
  implemented: (workspace: RegisteredWorkspace, _itemId: WorkItemId, _outcome: ImplementedOutcome) =>
    failWhenRemote(workspace),
  followedUp: (workspace: RegisteredWorkspace, _itemId: WorkItemId, _outcome: FollowedUpOutcome) =>
    failWhenRemote(workspace),
  attemptFailed: (workspace: RegisteredWorkspace, _itemId: WorkItemId, _outcome: AttemptFailedOutcome) =>
    failWhenRemote(workspace),
  handOff: (workspace: RegisteredWorkspace, _itemId: WorkItemId, _outcome: HandOffOutcome) =>
    failWhenRemote(workspace),
  stalled: (workspace: RegisteredWorkspace, _itemId: WorkItemId, _outcome: StalledOutcome) =>
    failWhenRemote(workspace),
  reclassify: (workspace: RegisteredWorkspace, _itemId: WorkItemId, _outcome: ReclassifyOutcome) =>
    failWhenRemote(workspace),
} as const);

export type IssueTrackerService = Effect.Success<typeof makeEmpty>;

export class IssueTracker extends Context.Service<IssueTracker, IssueTrackerService>()(
  "@cogwork/engine/issue-tracker/IssueTracker",
) {}

export const emptyLayer = Layer.effect(IssueTracker, makeEmpty);

export const releaseClaim = (tracker: IssueTrackerService) =>
  Effect.fn("IssueTracker.releaseClaim")(function* (workspace: RegisteredWorkspace, itemId: WorkItemId) {
    yield* tracker.release(workspace, itemId).pipe(
      Effect.catchTag("IssueTrackerError", (error) =>
        Effect.logWarning("claim release failed", {
          workspace: workspace.config.name,
          item: itemId,
          message: error.message,
        }),
      ),
    );
  });
