import {
  keyOf,
  ParkReason,
  WorkflowAttention as WorkflowAttentionSchema,
  type WorkflowParkCommand,
  WorkflowTouchpointFailure,
} from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { Coordination } from "./coordination";
import type { TriggerAdmission } from "./trigger-observation-admission";
import { TriggerObservationStore } from "./trigger-observation-store";
import { type TriggerEvent, TriggerEventPayload } from "./trigger-source";
import { Workflows } from "./workflow";
import { WorkflowActionPlanStore } from "./workflow-action-plan-store";

const skipReasonOfPayload = TriggerEventPayload.match({
  GranolaNote: () => null,
  GranolaNoteRejected: ({ reason }) => reason,
  NoLongerMatches: ({ reason }) => reason,
});

const skipReasonOf = ({ payload }: TriggerEvent) => (payload ? skipReasonOfPayload(payload) : null);

export const parkCommandsByReason = {
  Stuck: ["hand-back"],
  Exhausted: ["hand-back"],
  HopCap: ["hand-back"],
  MissingOperation: ["open-workflow", "hand-back"],
  PlanRejected: ["hand-back"],
  WriteFailed: ["hand-back"],
  DraftOutcomeUnknown: ["hand-back"],
  NoWorkspaceRecognized: ["hand-back"],
  WorktreeBlocked: ["hand-back"],
  AwaitingApproval: ["approve", "reject", "hand-back"],
  HandedToYou: ["choose-answer", "hand-back"],
  Cancelled: ["hand-back"],
} satisfies Record<ParkReason["_tag"], ReadonlyArray<WorkflowParkCommand>>;

type WorktreeBlocked = Extract<ParkReason, { readonly _tag: "WorktreeBlocked" }>;

const worktreeBlockedSummaries = {
  "operation-in-progress": ({ branch, operation }: WorktreeBlocked) =>
    `Branch ${branch} has a ${operation ?? "Git operation"} in progress in its worktree. Finish or abort it.`,
  diverged: ({ branch }: WorktreeBlocked) =>
    `Branch ${branch} has diverged from its remote. Reconcile the branch in its worktree.`,
  detached: ({ branch }: WorktreeBlocked) =>
    `The worktree for branch ${branch} is not registered with Git and can hold uncommitted work. Move or remove it.`,
  "unsafe-branch": ({ branch }: WorktreeBlocked) =>
    `Branch ${branch} does not resolve below the worktree root. Use a different branch.`,
} satisfies Record<WorktreeBlocked["reason"], (reason: WorktreeBlocked) => string>;

const summaryByReason = {
  Stuck: (reason: Extract<ParkReason, { readonly _tag: "Stuck" }>) => reason.summary,
  Exhausted: (reason: Extract<ParkReason, { readonly _tag: "Exhausted" }>) => reason.reason,
  HopCap: () => "Workflow lineage reached its hop cap",
  MissingOperation: () => "The published Workflow no longer has this Operation",
  PlanRejected: (reason: Extract<ParkReason, { readonly _tag: "PlanRejected" }>) => reason.reason,
  WriteFailed: (reason: Extract<ParkReason, { readonly _tag: "WriteFailed" }>) => reason.error,
  DraftOutcomeUnknown: () => "Slack draft outcome is unknown; check Slack before continuing",
  NoWorkspaceRecognized: () => "No Workspace was recognized",
  WorktreeBlocked: (reason: WorktreeBlocked) => worktreeBlockedSummaries[reason.reason](reason),
  AwaitingApproval: () => "The plan is waiting for approval",
  HandedToYou: () => "The Operation handed this item to you",
  Cancelled: ({ note }: Extract<ParkReason, { readonly _tag: "Cancelled" }>) =>
    note === undefined ? "A person cancelled the Run" : `A person cancelled the Run: ${note}`,
} satisfies {
  [Tag in ParkReason["_tag"]]: (reason: Extract<ParkReason, { readonly _tag: Tag }>) => string;
};

export const parkSummary = (reason: ParkReason) => ParkReason.match(reason, summaryByReason);

const parkedAdmissions = (admissions: ReadonlyArray<TriggerAdmission>) =>
  admissions
    .toSorted((left, right) => left.event.atMillis - right.event.atMillis)
    .filter(
      (admission, index, ordered) =>
        ordered.findIndex(
          (candidate) =>
            keyOf(candidate.event.key) === keyOf(admission.event.key) &&
            candidate.subscription.workflow === admission.subscription.workflow,
        ) === index,
    );

export const make = Effect.gen(function* () {
  const coordination = yield* Coordination;
  const observationStore = yield* TriggerObservationStore;
  const actionPlans = yield* WorkflowActionPlanStore;
  const workflows = yield* Workflows;

  return {
    list: Effect.all([
      observationStore.admissions,
      observationStore.processed,
      actionPlans.list,
      workflows.list,
    ]).pipe(
      Effect.flatMap(([admissions, processed, plans, listed]) => {
        const records = new Map(listed.workflows.map((record) => [record.id, record]));
        return Effect.forEach(parkedAdmissions(admissions), (admission) =>
          coordination.read(admission.event.key).pipe(
            Effect.map((view) => {
              const operation = {
                workflow: admission.subscription.workflow,
                operation: admission.subscription.operation,
              };
              const gate = view.gate(operation, admission.event.revision);
              if (gate._tag !== "Parked") return null;
              const item = keyOf(admission.event.key);
              const plan = plans
                .filter((candidate) => candidate.item === item && candidate.workflow === operation.workflow)
                .toSorted((left, right) => right.createdAtMillis - left.createdAtMillis)
                .at(0);
              const changedSinceParked = admissions.some(
                (candidate) =>
                  keyOf(candidate.event.key) === item &&
                  candidate.event.revision !== admission.event.revision,
              );
              const record = records.get(operation.workflow);
              return {
                item: admission.event.key,
                workflow: admission.subscription.workflow,
                publishedRevision: record?.publishedRevision ?? 0,
                operation: admission.subscription.operation,
                lineage: admission.lineage,
                summary: plan?.summary ?? parkSummary(gate.reason),
                changedSinceParked,
                commands: parkCommandsByReason[gate.reason._tag],
                reason: gate.reason,
                attempt: plan?.attempt ?? null,
                parkedAtMillis: view.park?.atMillis ?? plan?.createdAtMillis ?? admission.event.atMillis,
                plan: plan ?? null,
              };
            }),
          ),
        ).pipe(
          Effect.map((parks) =>
            WorkflowAttentionSchema.make({
              parks: parks.filter((park) => park !== null),
              skipped: listed.workflows.map(({ id }) => ({
                workflow: id,
                steps: plans
                  .filter(({ workflow }) => workflow === id)
                  .flatMap(({ steps, createdAtMillis }) =>
                    steps
                      .filter(({ target }) => target._tag === "NoWorkspace")
                      .map(({ entry }) => ({
                        summary: entry,
                        reason: "No Workspace was recognized",
                        atMillis: createdAtMillis,
                      })),
                  ),
                events: processed.flatMap((admission) => {
                  const reason = skipReasonOf(admission.event);
                  return admission.subscription.workflow === id && reason !== null
                    ? [{ summary: admission.event.entry, reason, atMillis: admission.event.atMillis }]
                    : [];
                }),
              })),
            }),
          ),
        );
      }),
      Effect.mapError(
        (error) =>
          new WorkflowTouchpointFailure({
            reason: "unavailable",
            message: error instanceof Error ? error.message : String(error),
          }),
      ),
    ),
  } as const;
});

export class WorkflowAttention extends Context.Reference<Effect.Success<typeof make>>(
  "@cogwork/engine/workflow-attention/WorkflowAttention",
  {
    defaultValue: () => ({
      list: Effect.fail(new WorkflowTouchpointFailure({ reason: "unavailable", message: "unavailable" })),
    }),
  },
) {}

export const layer = Layer.effect(WorkflowAttention, make);
