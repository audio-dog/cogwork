import {
  BranchName,
  type HarnessName,
  issueTrackerErrorIsPermanent,
  type MachineReadiness,
  type ParkReason,
  PluginContributionLoad,
  RunId,
  type WorkflowDocument,
  type WorkflowOperation,
  WorkItemId,
  WorkItemRef,
  type WorkspaceId,
} from "@cogwork/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ContextAssembler } from "./context-assembler";
import { Coordination } from "./coordination";
import { Harness } from "./harness";
import { IssueTrackerError } from "./issue-tracker";
import { PluginManager } from "./plugin";
import type { RegisteredWorkspace } from "./projector";
import { RunLedger } from "./run-ledger";
import { subagentMembers } from "./run-plan";
import { HarnessPreflight, harnessOptions } from "./run-plan-resolution";
import { SessionStore } from "./session-store";
import { SourceControlProvider } from "./source-control";
import type { TriggerAdmission } from "./trigger-observation-admission";
import { WorkflowArtifactStore } from "./workflow-artifact-store";
import { ticketSlug, type WorktreeError, WorktreeManager } from "./worktree";

const workItemId = Schema.decodeSync(WorkItemId);

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

export class CheckoutRefused extends Data.TaggedError("CheckoutRefused")<{
  readonly message: string;
  readonly park: ParkReason | null;
}> {}

export const selectedWorkspaceIds = (
  document: WorkflowDocument,
  workspaces: ReadonlyArray<RegisteredWorkspace>,
) => {
  const registered = workspaces.map(({ config }) => config.id);
  return document.workspaces._tag === "Every"
    ? registered
    : document.workspaces.workspaces.filter((workspace) => registered.includes(workspace));
};

export interface RunPreparationInput {
  readonly admission: TriggerAdmission;
  readonly workspace: RegisteredWorkspace | null;
  readonly operation: WorkflowOperation;
  readonly harness: HarnessName;
  readonly run: { readonly id: RunId; readonly workspace: WorkspaceId; readonly startedAtMillis: number };
  readonly pendingPlanAttempt: RunId | null;
}

export const make = Effect.gen(function* () {
  const harness = yield* Harness;
  const sessions = yield* SessionStore;
  const ledger = yield* RunLedger;
  const coordination = yield* Coordination;
  const contextAssembler = yield* ContextAssembler;
  const artifacts = yield* WorkflowArtifactStore;
  const fs = yield* FileSystem.FileSystem;
  const sourceControl = Option.getOrNull(yield* Effect.serviceOption(SourceControlProvider));
  const worktrees = Option.getOrNull(yield* Effect.serviceOption(WorktreeManager));
  const plugins = yield* PluginManager;

  const admittedSkills = Effect.fn("RunPreparation.admittedSkills")(function* (
    workspace: RegisteredWorkspace | null,
    required: ReadonlyArray<string>,
  ) {
    if (workspace === null) return [];
    const fromPlugins = yield* plugins.contributions(workspace.config.id).pipe(
      Effect.map((contributions) =>
        contributions.filter(({ load }) => PluginContributionLoad.guards.Loaded(load)),
      ),
      Effect.orElseSucceed(() => []),
    );
    const available = [...workspace.contributions, ...fromPlugins].filter(({ kind }) => kind === "skill");
    const contributions = [
      ...available.filter(({ id }) => required.includes(id)),
      ...available.filter(({ id }) => !required.includes(id)),
    ];
    return contributions
      .filter(
        (skill, index) => contributions.findIndex(({ localName }) => localName === skill.localName) === index,
      )
      .map(({ id, localName, file }) => ({ identity: id, name: localName, source: file }));
  });

  const preflight = Effect.fn("RunPreparation.preflight")(function* (
    operation: WorkflowOperation,
    machine: Pick<MachineReadiness, "defaultHarness" | "readyNeeds">,
  ) {
    const name = operation.model.harness ?? machine.defaultHarness;
    if (name === null) return HarnessPreflight.Unselected();
    const need = operation.requires.find((required) => !machine.readyNeeds.includes(required));
    if (need !== undefined) return HarnessPreflight.NeedMissing({ need });
    return yield* harness
      .preflight(name, operation.permissionProfile, operation.model.model, harnessOptions(operation))
      .pipe(
        Effect.match({
          onFailure: ({ message }) => HarnessPreflight.Failed({ name, message }),
          onSuccess: () =>
            HarnessPreflight.Passed({
              name,
              projectedMembers: harness.projectedMembers(name),
              middleware: harness.planMiddleware(name),
              sessionKind: harness.sessionKind(name),
            }),
        }),
      );
  });

  const ensureCheckout = Effect.fn("RunPreparation.ensureCheckout")(function* (
    admission: TriggerAdmission,
    workspace: RegisteredWorkspace | null,
    permissionProfile: WorkflowOperation["permissionProfile"],
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
      sourceControl === null ? null : yield* sourceControl.resolvePullRequest(workspace, admission.event.key);
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

  const checkoutPark = (error: Effect.Error<ReturnType<typeof ensureCheckout>>) =>
    Match.valueTags(error, {
      WorktreeError: (failure) => (failure.retryable ? null : worktreeBlocked(failure)),
      IssueTrackerError: (failure) =>
        exhaustedUnlessRetryable({
          retryable: !issueTrackerErrorIsPermanent(failure),
          message: failure.message,
        }),
      GitError: exhaustedUnlessRetryable,
      WorktreeFsError: exhaustedUnlessRetryable,
      PlatformError: () => null,
    });

  const prepare = Effect.fn("RunPreparation.prepare")(function* (input: RunPreparationInput) {
    const { admission, workspace, operation, run } = input;
    const view = yield* coordination.read(admission.event.key);
    const handback =
      view.handback !== null && view.handback.atMillis > admission.event.atMillis ? view.handback : null;
    const handedBackAttempt =
      handback === null || admission.lineage.parent === null ? null : RunId.make(admission.lineage.parent);
    const resumedAttempt = input.pendingPlanAttempt ?? handedBackAttempt;
    const resumedRun = resumedAttempt === null ? null : yield* ledger.getRun(resumedAttempt);
    const resumedSession = resumedRun?.session ?? null;
    const checkout = yield* ensureCheckout(
      admission,
      workspace,
      operation.permissionProfile,
      resumedSession !== null,
    ).pipe(
      Effect.mapError((error) => new CheckoutRefused({ message: error.message, park: checkoutPark(error) })),
    );
    const session =
      resumedSession ??
      (yield* sessions.mint(
        { workspace: run.workspace, harness: input.harness, createdAtMillis: run.startedAtMillis },
        harness.sessionKind,
      ));
    const instructions = yield* contextAssembler.assemble({
      runId: run.id,
      workspace: run.workspace,
      cwd: checkout.path,
      projectRoot: checkout.path,
      operatingInstructions: operation,
      contributions: [],
    });
    yield* Effect.addFinalizer(() => contextAssembler.cleanup(run.id).pipe(Effect.ignore));
    return {
      checkout,
      session,
      handback,
      instructions,
      lineageArtifacts: yield* artifacts.byLineage(admission.lineage.root),
      subagents: yield* subagentMembers(workspace?.contributions ?? [], operation.requires),
    };
  });

  return { preflight, admittedSkills, prepare } as const;
});
