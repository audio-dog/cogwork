import {
  BranchName,
  issueTrackerErrorIsPermanent,
  type ParkReason,
  WorkItemId,
  WorkItemRef,
} from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import type * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { IssueTrackerError } from "./issue-tracker";
import type { RegisteredWorkspace } from "./projector";
import { SourceControlProvider } from "./source-control";
import type { TriggerAdmission } from "./trigger-observation";
import type { ClaimedWork, ClaimState, makeClaim } from "./workflow-run-claim";
import { ticketSlug, type WorktreeError, WorktreeManager } from "./worktree";

export const workItemId = Schema.decodeSync(WorkItemId);

const fallbackBranch = WorkItemRef.match({
  Issue: ({ id }) => ticketSlug(id),
  PullRequest: () => "pull-request",
  GranolaNote: () => "workflow",
  SlackMessage: () => "workflow",
  SlackConversation: () => "workflow",
  ScheduleInstant: () => "workflow",
  FanOutChild: () => "workflow",
});

const runItemId = WorkItemRef.match({
  Issue: ({ id }) => id,
  PullRequest: ({ number }) => workItemId(`#${number}`),
  GranolaNote: () => workItemId("#workflow"),
  SlackMessage: () => workItemId("#workflow"),
  SlackConversation: () => workItemId("#workflow"),
  ScheduleInstant: () => workItemId("#workflow"),
  FanOutChild: () => workItemId("#workflow"),
});

const worktreeBlocked = ({ reason, branch, path, operation, unmergedPaths }: WorktreeError): ParkReason => ({
  _tag: "WorktreeBlocked",
  reason,
  branch,
  path,
  operation,
  unmergedPaths,
});

const exhaustedUnlessRetryable = (error: { readonly retryable: boolean; readonly message: string }) =>
  error.retryable ? null : ({ _tag: "Exhausted", reason: error.message } satisfies ParkReason);

export const makeCheckout = ({
  failAttempt,
  parkClaimed,
  recordClaimedAttempt,
  settleClaimed,
}: Pick<
  Effect.Success<ReturnType<typeof makeClaim>>,
  "failAttempt" | "parkClaimed" | "recordClaimedAttempt" | "settleClaimed"
>) =>
  Effect.gen(function* () {
    const sourceControl = Option.getOrNull(yield* Effect.serviceOption(SourceControlProvider));
    const worktrees = Option.getOrNull(yield* Effect.serviceOption(WorktreeManager));
    const fs = yield* FileSystem.FileSystem;
    const pullRequestBuildInput = (runBranch: string | null) => ({
      ...(sourceControl ? { sourceControl } : {}),
      ...(worktrees ? { worktrees } : {}),
      ...(runBranch ? { runBranch } : {}),
    });

    const prepareCheckout = Effect.fn("WorkflowRun.prepareCheckout")(function* (
      admission: TriggerAdmission,
      workspace: RegisteredWorkspace | null,
      permissionProfile: "read-only" | "full",
      resume: boolean,
    ) {
      if (workspace === null) {
        const path = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-workflow-" });
        return { path, branch: null } as const;
      }
      if (permissionProfile === "read-only") {
        return { path: workspace.config.checkoutPath, branch: null } as const;
      }
      const pullRequest =
        sourceControl === null
          ? null
          : yield* sourceControl.resolvePullRequest(workspace, admission.event.key);
      const branch = BranchName.make(pullRequest?.headBranch ?? fallbackBranch(admission.event.key));
      const item = { id: runItemId(admission.event.key), title: "" };
      if (worktrees === null) {
        return yield* new IssueTrackerError({
          reason: "unavailable",
          retryable: false,
          message: "Worktree manager is not configured",
        });
      }
      const checkout = yield* worktrees.ensure(workspace, item, {
        branch,
        pushOwner: "engine",
        resume,
      });
      return { path: checkout.path, branch } as const;
    });

    const preparationPark = (error: Effect.Error<ReturnType<typeof prepareCheckout>>) =>
      Match.valueTags(error, {
        WorktreeError: worktreeBlocked,
        IssueTrackerError: (failure) =>
          exhaustedUnlessRetryable({
            retryable: !issueTrackerErrorIsPermanent(failure),
            message: failure.message,
          }),
        GitError: exhaustedUnlessRetryable,
        WorktreeFsError: exhaustedUnlessRetryable,
        PlatformError: () => null,
      });

    const refusePreparation = Effect.fn("WorkflowRun.refusePreparation")(function* (
      admission: TriggerAdmission,
      claimed: Ref.Ref<ClaimState>,
      work: ClaimedWork,
      error: Effect.Error<ReturnType<typeof prepareCheckout>>,
    ) {
      const park = preparationPark(error);
      if (park === null) return yield* failAttempt(admission, claimed, work, error.message);
      yield* recordClaimedAttempt(admission, claimed, work, { outcome: "failed", reason: error.message });
      yield* settleClaimed(claimed, "failed");
      yield* parkClaimed(admission, work, park);
      return "completed" as const;
    });

    return { pullRequestBuildInput, prepareCheckout, refusePreparation };
  });
