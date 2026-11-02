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
import { type TriggerAdmission, TriggerObservationStore } from "./trigger-observation";
import { Workflows } from "./workflow";
import { WorkflowActionPlanStore } from "./workflow-action-plan-store";

const commandsByReason = {
  Stuck: ["hand-back"],
  Exhausted: ["hand-back"],
  HopCap: ["hand-back"],
  MissingOperation: ["open-workflow", "hand-back"],
  PlanRejected: ["hand-back"],
  WriteFailed: ["hand-back"],
  DraftOutcomeUnknown: ["hand-back"],
  NoWorkspaceRecognized: ["hand-back"],
  AwaitingApproval: ["approve", "reject", "hand-back"],
  HandedToYou: ["choose-answer", "hand-back"],
} satisfies Record<ParkReason["_tag"], ReadonlyArray<WorkflowParkCommand>>;

const summaryByReason = {
  Stuck: (reason: Extract<ParkReason, { readonly _tag: "Stuck" }>) => reason.summary,
  Exhausted: (reason: Extract<ParkReason, { readonly _tag: "Exhausted" }>) => reason.reason,
  HopCap: () => "Workflow lineage reached its hop cap",
  MissingOperation: () => "The published Workflow no longer has this Operation",
  PlanRejected: (reason: Extract<ParkReason, { readonly _tag: "PlanRejected" }>) => reason.reason,
  WriteFailed: (reason: Extract<ParkReason, { readonly _tag: "WriteFailed" }>) => reason.error,
  DraftOutcomeUnknown: () => "Slack draft outcome is unknown; check Slack before continuing",
  NoWorkspaceRecognized: () => "No Workspace was recognized",
  AwaitingApproval: () => "The plan is waiting for approval",
  HandedToYou: () => "The Operation handed this item to you",
} satisfies {
  [Tag in ParkReason["_tag"]]: (reason: Extract<ParkReason, { readonly _tag: Tag }>) => string;
};

const summaryOf = (reason: ParkReason) => ParkReason.match(reason, summaryByReason);

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
                summary: plan?.summary ?? summaryOf(gate.reason),
                changedSinceParked,
                commands: commandsByReason[gate.reason._tag],
                reason: gate.reason,
                attempt: plan?.attempt ?? null,
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
                  .flatMap(({ steps }) =>
                    steps
                      .filter(({ target }) => target._tag === "NoWorkspace")
                      .map(({ entry }) => ({
                        summary: entry,
                        reason: "No Workspace was recognized",
                      })),
                  ),
                events: processed.flatMap((admission) =>
                  admission.subscription.workflow === id &&
                  admission.event.payload?._tag === "GranolaNoteRejected"
                    ? [
                        {
                          summary: admission.event.entry,
                          reason: admission.event.payload.reason,
                        },
                      ]
                    : [],
                ),
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
