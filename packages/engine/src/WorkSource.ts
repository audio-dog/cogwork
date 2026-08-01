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

const failWhenRemote = Effect.fn("WorkSource.guard")(function* (workspace: RegisteredWorkspace) {
  if (!workspace.config.workSource.repo) {
    return yield* Effect.void;
  }
  return yield* noAdapter(workspace);
});

const observeEmpty = Effect.fn("WorkSource.observe")(function* (workspace: RegisteredWorkspace) {
  if (workspace.config.workSource.repo) {
    return yield* noAdapter(workspace);
  }
  return [] as ReadonlyArray<ObservedItem>;
});

const claimEmpty = (workspace: RegisteredWorkspace, _itemId: WorkItemId, _claim: Claim) =>
  failWhenRemote(workspace);

const releaseEmpty = (workspace: RegisteredWorkspace, _itemId: WorkItemId) => failWhenRemote(workspace);

const recordAttemptEmpty = (workspace: RegisteredWorkspace, _itemId: WorkItemId, _attempt: AttemptRecord) =>
  failWhenRemote(workspace);

const recordFollowUpEmpty = (
  workspace: RegisteredWorkspace,
  _itemId: WorkItemId,
  _marker: FollowUpMarker,
  _detail?: string,
) => failWhenRemote(workspace);

const noteEmpty = (workspace: RegisteredWorkspace, _itemId: WorkItemId, _detail: string) =>
  failWhenRemote(workspace);

const setRolesEmpty = (workspace: RegisteredWorkspace, _itemId: WorkItemId, _changes: RoleChanges) =>
  failWhenRemote(workspace);

export const makeEmpty = Effect.succeed({
  observe: observeEmpty,
  claim: claimEmpty,
  release: releaseEmpty,
  recordAttempt: recordAttemptEmpty,
  recordFollowUp: recordFollowUpEmpty,
  note: noteEmpty,
  setRoles: setRolesEmpty,
} as const);

export type WorkSourceService = Effect.Success<typeof makeEmpty>;

export class WorkSource extends Context.Service<WorkSource, WorkSourceService>()(
  "@clanker-forge/engine/WorkSource",
) {}

export const emptyLayer = Layer.effect(WorkSource, makeEmpty);
