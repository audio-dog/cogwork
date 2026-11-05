import {
  BranchName,
  type HarnessName,
  type MachineReadiness,
  type ModelOptionSelections,
  type NeedIdentity,
  RunId,
  type RunPlanMiddlewareName,
  type SessionId,
  type SessionKind,
  type WorkflowActionArtifact,
  type WorkflowOperation,
  WorkItemId,
  WorkItemRef,
  type WorkspaceId,
} from "@cogwork/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { type AssembledContext, ContextAssembler } from "./context-assembler";
import { Coordination } from "./coordination";
import { Harness } from "./harness";
import { IssueTrackerError } from "./issue-tracker";
import type { RegisteredWorkspace } from "./projector";
import { RunLedger } from "./run-ledger";
import { SessionStore } from "./session-store";
import { SourceControlProvider } from "./source-control";
import type { TriggerAdmission } from "./trigger-observation";
import { WorkflowArtifactStore } from "./workflow-artifact-store";
import { ticketSlug, WorktreeManager } from "./worktree";

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

export interface RunReadiness {
  readonly harness: HarnessName | null;
  readonly missingNeeds: ReadonlyArray<NeedIdentity>;
  readonly preflightFailure: string | null;
}

export interface ProvisionedRun {
  readonly harness: HarnessName;
  readonly options: ModelOptionSelections;
  readonly checkout: { readonly path: string; readonly branch: BranchName | null };
  readonly session: SessionId;
  readonly sessionKind: SessionKind;
  readonly middleware: ReadonlyArray<RunPlanMiddlewareName>;
  readonly instructions: AssembledContext;
  readonly handbackNote: string | undefined;
  readonly lineageArtifacts: ReadonlyArray<WorkflowActionArtifact>;
}

export type PreparedRun = Data.TaggedEnum<{
  Unready: { readonly readiness: RunReadiness };
  Ready: { readonly provisioned: ProvisionedRun };
}>;
export const PreparedRun = Data.taggedEnum<PreparedRun>();

export interface RunPreparationRequest {
  readonly id: RunId;
  readonly admission: TriggerAdmission;
  readonly operation: WorkflowOperation;
  readonly machine: MachineReadiness;
  readonly workspace: RegisteredWorkspace | null;
  readonly runWorkspace: WorkspaceId;
  readonly pendingAttempt: RunId | null;
  readonly startedAtMillis: number;
}

export const make = Effect.gen(function* () {
  const harness = yield* Harness;
  const sessions = yield* SessionStore;
  const ledger = yield* RunLedger;
  const coordination = yield* Coordination;
  const contextAssembler = yield* ContextAssembler;
  const artifacts = yield* WorkflowArtifactStore;
  const sourceControl = Option.getOrNull(yield* Effect.serviceOption(SourceControlProvider));
  const worktrees = Option.getOrNull(yield* Effect.serviceOption(WorktreeManager));
  const fs = yield* FileSystem.FileSystem;

  const prepareCheckout = Effect.fn("RunPreparation.prepareCheckout")(function* (
    admission: TriggerAdmission,
    workspace: RegisteredWorkspace | null,
    permissionProfile: WorkflowOperation["permissionProfile"],
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
    });
    return { path: checkout.path, branch } as const;
  });

  const provision = Effect.fn("RunPreparation.provision")(function* (
    request: RunPreparationRequest,
    selectedHarness: HarnessName,
    options: ModelOptionSelections,
  ) {
    const { admission, operation } = request;
    const checkout = yield* prepareCheckout(admission, request.workspace, operation.permissionProfile);
    const coordinationView = yield* coordination.read(admission.event.key);
    const handback =
      coordinationView.handback !== null && coordinationView.handback.atMillis > admission.event.atMillis
        ? coordinationView.handback
        : null;
    const parkedAttempt = admission.lineage.parent === null ? null : RunId.make(admission.lineage.parent);
    const resumedAttempt = request.pendingAttempt ?? (handback === null ? null : parkedAttempt);
    const resumedRun = resumedAttempt === null ? null : yield* ledger.getRun(resumedAttempt);
    const session =
      resumedRun?.session ??
      (yield* sessions.mint(
        {
          workspace: request.runWorkspace,
          harness: selectedHarness,
          createdAtMillis: request.startedAtMillis,
        },
        harness.sessionKind,
      ));
    const instructions = yield* contextAssembler.assemble({
      runId: request.id,
      workspace: request.runWorkspace,
      cwd: checkout.path,
      projectRoot: checkout.path,
      operatingInstructions: operation,
      contributions: [],
    });
    yield* Effect.addFinalizer(() => contextAssembler.cleanup(request.id).pipe(Effect.ignore));
    const lineageArtifacts = yield* artifacts.byLineage(admission.lineage.root);
    return PreparedRun.Ready({
      provisioned: {
        harness: selectedHarness,
        options,
        checkout,
        session,
        sessionKind: harness.sessionKind(selectedHarness),
        middleware: harness.planMiddleware(selectedHarness),
        instructions,
        handbackNote: handback?.note?.trim(),
        lineageArtifacts,
      },
    });
  });

  const prepare = Effect.fn("RunPreparation.prepare")(function* (request: RunPreparationRequest) {
    const { operation, machine } = request;
    const selectedHarness = operation.model.harness ?? machine.defaultHarness;
    const missingNeeds = operation.requires.filter((need) => !machine.readyNeeds.includes(need));
    if (selectedHarness === null || missingNeeds.length > 0) {
      return PreparedRun.Unready({
        readiness: { harness: selectedHarness, missingNeeds, preflightFailure: null },
      });
    }
    const options = Object.fromEntries(operation.model.options.map(({ id, value }) => [id, value]));
    const preflight = yield* Effect.result(
      harness.preflight(selectedHarness, operation.permissionProfile, operation.model.model, options),
    );
    if (Result.isFailure(preflight)) {
      return PreparedRun.Unready({
        readiness: { harness: selectedHarness, missingNeeds, preflightFailure: preflight.failure.message },
      });
    }
    return yield* provision(request, selectedHarness, options);
  });

  return { prepare } as const;
});
