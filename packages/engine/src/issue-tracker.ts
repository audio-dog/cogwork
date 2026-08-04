import {
  type AttemptRecord,
  type Claim,
  PollPauseReason,
  type TriageRole,
  type WorkItemId,
} from "@clanker-forge/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { FollowUpMarker, ObservedPr } from "./follow-up";
import type { RegisteredWorkspace } from "./projector";

export type { BaseDivergence, FollowUpMarker, ObservedPr, PrReview } from "./follow-up";

interface ObservedItemBase {
  readonly id: WorkItemId;
  readonly title: string;
  readonly roles: ReadonlyArray<TriageRole>;
  readonly claimLabeled: boolean;
  readonly claim: Claim | null;
  readonly attempts: ReadonlyArray<AttemptRecord>;
  readonly openBlockers: number;
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

export class IssueTrackerError extends Schema.TaggedErrorClass<IssueTrackerError>()("IssueTrackerError", {
  reason: PollPauseReason,
  message: Schema.String,
  retryAfterMillis: Schema.optional(Schema.Finite),
}) {}

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
  claim: (workspace: RegisteredWorkspace, _itemId: WorkItemId, _claim: Claim) => failWhenRemote(workspace),
  release: (workspace: RegisteredWorkspace, _itemId: WorkItemId) => failWhenRemote(workspace),
  recordAttempt: (
    workspace: RegisteredWorkspace,
    _itemId: WorkItemId,
    _attempt: AttemptRecord,
    _reason?: string,
  ) => failWhenRemote(workspace),
  recordFollowUp: (
    workspace: RegisteredWorkspace,
    _itemId: WorkItemId,
    _marker: FollowUpMarker,
    _detail?: string,
  ) => failWhenRemote(workspace),
  note: (workspace: RegisteredWorkspace, _itemId: WorkItemId, _detail: string) => failWhenRemote(workspace),
  setRoles: (workspace: RegisteredWorkspace, _itemId: WorkItemId, _changes: RoleChanges) =>
    failWhenRemote(workspace),
} as const);

export type IssueTrackerService = Effect.Success<typeof makeEmpty>;

export class IssueTracker extends Context.Service<IssueTracker, IssueTrackerService>()(
  "@clanker-forge/engine/issue-tracker/IssueTracker",
) {}

export const emptyLayer = Layer.effect(IssueTracker, makeEmpty);
