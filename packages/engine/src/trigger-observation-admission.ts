import {
  defaultPriority,
  keyOf,
  Lineage,
  type ParkReason,
  priorityRank,
  WorkItemId,
  WorkspaceId,
} from "@cogwork/contracts";
import * as Schema from "effect/Schema";

import { TriggerEvent, TriggerSubscription } from "./trigger-source";

export const TriggerAdmission = Schema.Struct({
  event: TriggerEvent,
  subscription: TriggerSubscription,
  lineage: Lineage,
});
export type TriggerAdmission = typeof TriggerAdmission.Type;

const decodeWorkspaceId = Schema.decodeSync(WorkspaceId);
const decodeWorkItemId = Schema.decodeSync(WorkItemId);

export const runWorkspaceOf = (admission: TriggerAdmission) =>
  admission.event.workspace ?? decodeWorkspaceId(admission.subscription.workflow);
export const runWorkItemOf = (admission: TriggerAdmission) => decodeWorkItemId(keyOf(admission.event.key));

export const subscriptionKey = ({ workflow, trigger }: TriggerSubscription) => `${workflow}:${trigger}`;
export const admissionKey = (admission: TriggerAdmission) =>
  `${keyOf(admission.event.key)}:${admission.event.revision}:${subscriptionKey(admission.subscription)}`;
export const sameRevision = (left: TriggerAdmission, right: TriggerAdmission) =>
  keyOf(left.event.key) === keyOf(right.event.key) && left.event.revision === right.event.revision;
export const admissionIsOlder = (candidate: TriggerAdmission, current: TriggerAdmission) =>
  candidate.event.atMillis < current.event.atMillis ||
  (candidate.event.atMillis === current.event.atMillis && candidate.event.revision < current.event.revision);
export const oldestRevisionAdmissions = (admissions: ReadonlyArray<TriggerAdmission>) => {
  const oldestByItem = admissions.reduce((oldest, admission) => {
    const item = keyOf(admission.event.key);
    const current = oldest.get(item);
    return current === undefined || admissionIsOlder(admission, current)
      ? new Map(oldest).set(item, admission)
      : oldest;
  }, new Map<string, TriggerAdmission>());
  return admissions.filter((admission) => {
    const oldest = oldestByItem.get(keyOf(admission.event.key));
    return oldest !== undefined && sameRevision(admission, oldest);
  });
};

interface WaitingAdmission {
  readonly admission: TriggerAdmission;
  readonly actedOn: boolean;
}

export const waitingAdmissionOrder = (left: WaitingAdmission, right: WaitingAdmission) =>
  Number(right.actedOn) - Number(left.actedOn) ||
  priorityRank.indexOf(left.admission.event.priority ?? defaultPriority) -
    priorityRank.indexOf(right.admission.event.priority ?? defaultPriority) ||
  left.admission.event.atMillis - right.admission.event.atMillis;

export const revisionAdvancedParks = new Set<ParkReason["_tag"]>([
  "AwaitingApproval",
  "MissingOperation",
  "PlanRejected",
]);

export const sameSubscription = (left: TriggerAdmission, right: TriggerAdmission) =>
  keyOf(left.event.key) === keyOf(right.event.key) &&
  left.subscription.workflow === right.subscription.workflow &&
  left.subscription.trigger === right.subscription.trigger;
export const checkpointOf = (admission: TriggerAdmission) =>
  admission.event.key._tag === "ScheduleInstant"
    ? admission.event.key.instantMillis
    : admission.event.atMillis;
