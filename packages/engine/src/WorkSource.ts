import type { AttemptRecord, Claim, TriageRole, WorkItemId } from "@clanker-forge/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { FollowUpMarker, ObservedPr } from "./followUp";
import type { RegisteredWorkspace } from "./projector";

export type { FollowUpMarker, ObservedPr, PrReview } from "./followUp";

export interface ObservedItem {
  readonly id: WorkItemId;
  readonly title: string;
  readonly roles: ReadonlyArray<TriageRole>;
  readonly claimLabeled: boolean;
  readonly claim: Claim | null;
  readonly attempts: ReadonlyArray<AttemptRecord>;
  readonly pr: ObservedPr | null;
}

export interface RoleChanges {
  readonly add: ReadonlyArray<TriageRole>;
  readonly remove: ReadonlyArray<TriageRole>;
}

export class WorkSourceError extends Schema.TaggedErrorClass<WorkSourceError>()("WorkSourceError", {
  reason: Schema.Literals(["auth", "unavailable", "rate-limited"]),
  message: Schema.String,
}) {}

const noAdapter = (workspace: RegisteredWorkspace) =>
  new WorkSourceError({
    reason: "unavailable",
    message: `no work source adapter configured for ${workspace.config.name}`,
  });

const hasRemoteSource = (workspace: RegisteredWorkspace) => {
  const { type, team, repo } = workspace.config.workSource;
  return type === "linear" ? Boolean(team) : Boolean(repo);
};

const failWhenRemote = Effect.fn("WorkSource.guard")(function* (workspace: RegisteredWorkspace) {
  if (hasRemoteSource(workspace)) {
    return yield* noAdapter(workspace);
  }
  return yield* Effect.void;
});

const observeEmpty = Effect.fn("WorkSource.observe")(function* (workspace: RegisteredWorkspace) {
  if (hasRemoteSource(workspace)) {
    return yield* noAdapter(workspace);
  }
  return [] as ReadonlyArray<ObservedItem>;
});

export const makeEmpty = Effect.succeed({
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

export type WorkSourceService = Effect.Success<typeof makeEmpty>;

export class WorkSource extends Context.Service<WorkSource, WorkSourceService>()(
  "@clanker-forge/engine/WorkSource",
) {}

export const emptyLayer = Layer.effect(WorkSource, makeEmpty);
