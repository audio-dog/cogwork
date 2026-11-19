import { WorkItemId, WorkItemRef, type WorkspaceId } from "@cogwork/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import { IssueTracker } from "./issue-tracker";
import type { RegisteredWorkspace } from "./projector";
import { WorkspaceRegistry } from "./registry-service";
import type { TriggerEvent } from "./trigger-source";
import { pullMatchesLinkKey } from "./worktree-link-key";

interface AssigneeSnapshot {
  readonly atMillis: number;
  readonly assignees: ReadonlyMap<WorkItemId, ReadonlyArray<string>>;
}

const assigneeSnapshotTtl = 60_000;
const ungated = () => Effect.succeed(true);
const freshAssignees = (snapshot: AssigneeSnapshot | undefined, now: number) =>
  snapshot && now - snapshot.atMillis < assigneeSnapshotTtl ? snapshot.assignees : null;

export const makeAssigneeGate = Effect.gen(function* () {
  const tracker = yield* IssueTracker;
  const registry = yield* WorkspaceRegistry;
  const assigneeGate = Semaphore.makeUnsafe(1);
  const assigneeSnapshots = yield* Ref.make<ReadonlyMap<WorkspaceId, AssigneeSnapshot>>(new Map());

  const refreshWorkspaceAssignees = Effect.fn("TriggerObservation.refreshWorkspaceAssignees")(function* (
    workspace: RegisteredWorkspace,
    now: number,
  ) {
    const current = freshAssignees((yield* Ref.get(assigneeSnapshots)).get(workspace.config.id), now);
    if (current) return current;
    const items = yield* tracker.observe(workspace);
    const assignees = new Map(items.map(({ id, assignees }) => [id, assignees] as const));
    yield* Ref.update(assigneeSnapshots, (snapshots) =>
      new Map(snapshots).set(workspace.config.id, { atMillis: now, assignees }),
    );
    return assignees;
  });

  const refreshItemAssignees = Effect.fn("TriggerObservation.refreshItemAssignees")(function* (
    workspace: RegisteredWorkspace,
    itemId: WorkItemId,
    now: number,
  ) {
    const refreshed = yield* refreshWorkspaceAssignees(workspace, now);
    if (refreshed.has(itemId)) return refreshed.get(itemId) ?? [];
    const assignees = yield* tracker.assignees?.(workspace, itemId) ?? Effect.succeed([]);
    yield* Ref.update(assigneeSnapshots, (snapshots) =>
      new Map(snapshots).set(workspace.config.id, {
        atMillis: now,
        assignees: new Map(refreshed).set(itemId, assignees),
      }),
    );
    return assignees;
  });

  const itemAssignees = Effect.fn("TriggerObservation.itemAssignees")(function* (
    workspace: RegisteredWorkspace,
    itemId: WorkItemId,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const cached = freshAssignees((yield* Ref.get(assigneeSnapshots)).get(workspace.config.id), now);
    if (cached?.has(itemId)) return cached.get(itemId) ?? [];
    return yield* assigneeGate.withPermit(refreshItemAssignees(workspace, itemId, now));
  });

  const hasAllowlistedAssignee = Effect.fn("TriggerObservation.hasAllowlistedAssignee")(function* (
    workspace: RegisteredWorkspace,
    allowlist: ReadonlyArray<string>,
    itemId: WorkItemId,
  ) {
    const assignees = yield* itemAssignees(workspace, itemId);
    return assignees.some((assignee) => allowlist.includes(assignee));
  });

  const pullRequestLinkedItems = Effect.fn("TriggerObservation.pullRequestLinkedItems")(function* (
    workspace: RegisteredWorkspace,
    pullRequest: NonNullable<TriggerEvent["pullRequest"]>,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const observed = yield* assigneeGate.withPermit(refreshWorkspaceAssignees(workspace, now));
    const numbered =
      workspace.config.issueTracker.type === "github"
        ? [...pullRequest.closingIssueNumbers, ...(/^\d+/.exec(pullRequest.headRef) ?? [])].map((number) =>
            WorkItemId.make(`#${number}`),
          )
        : [];
    return [...new Set([...observed.keys(), ...numbered])].filter((id) =>
      pullMatchesLinkKey(id, pullRequest),
    );
  });

  const ownsPullRequest = Effect.fn("TriggerObservation.ownsPullRequest")(function* (
    workspace: RegisteredWorkspace,
    allowlist: ReadonlyArray<string>,
    pullRequest: TriggerEvent["pullRequest"],
  ) {
    if (pullRequest === undefined) return false;
    const linked = yield* pullRequestLinkedItems(workspace, pullRequest);
    if (linked.length === 0) return allowlist.includes(pullRequest.author);
    const owned = yield* Effect.findFirst(linked, (itemId) =>
      hasAllowlistedAssignee(workspace, allowlist, itemId),
    );
    return Option.isSome(owned);
  });

  const passesAssigneeGate = Effect.fn("TriggerObservation.passesAssigneeGate")(function* (
    event: TriggerEvent,
  ) {
    if (event.workspace === null) return true;
    const state = yield* registry.state;
    const workspace = state.workspaces.find(({ config }) => config.id === event.workspace);
    if (workspace === undefined) return false;
    const allowlist = workspace.config.issueTracker.assigneeAllowlist;
    if (allowlist === undefined) return true;
    return yield* WorkItemRef.match(event.key, {
      Issue: ({ id }) => hasAllowlistedAssignee(workspace, allowlist, id),
      PullRequest: () => ownsPullRequest(workspace, allowlist, event.pullRequest),
      GranolaNote: ungated,
      SlackMessage: ungated,
      SlackConversation: ungated,
      ScheduleInstant: ungated,
      FanOutChild: ungated,
    });
  });

  return passesAssigneeGate;
});
