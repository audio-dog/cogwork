import type { LifecycleStage, WorkItemId } from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import { attachCommand, type HandoffCause, handoffComment } from "./comments";
import type { IssueTrackerService } from "./issue-tracker";
import type { RegisteredWorkspace } from "./projector";
import { checkoutPathFor } from "./worktree";

export const handoffRoleFor = (stage: LifecycleStage) => {
  if (stage === "implement") return "ready-for-agent" as const;
  if (stage === "triage") return "needs-triage" as const;
  return null;
};

interface HandoffItem {
  readonly id: WorkItemId;
  readonly title: string;
}

export interface HandoffRequest {
  readonly workspace: RegisteredWorkspace;
  readonly item: HandoffItem;
  readonly stage: LifecycleStage;
  readonly cause: HandoffCause;
  readonly reason: string;
  readonly session: string | null | undefined;
}

export const releaseClaim = (tracker: IssueTrackerService) =>
  Effect.fn("HandToHuman.releaseClaim")(function* (workspace: RegisteredWorkspace, itemId: WorkItemId) {
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

export const handoffNote = (request: HandoffRequest) => {
  const { workspace, item, stage, cause, reason, session } = request;
  const checkout = checkoutPathFor(workspace.config.checkoutPath, item, stage, workspace.config.worktrees);
  const resume = session ? attachCommand(checkout, session) : undefined;
  return handoffComment(stage, cause, reason, resume);
};

export const handToHuman = (tracker: IssueTrackerService) =>
  Effect.fn("HandToHuman.handToHuman")(function* (request: HandoffRequest) {
    const { workspace, item, stage } = request;
    const role = handoffRoleFor(stage);
    yield* tracker.setRoles(workspace, item.id, {
      remove: role ? [role] : [],
      add: ["ready-for-human"],
    });
    yield* tracker.note(workspace, item.id, handoffNote(request));
  });
