import { keyOf, LineageId, type RunId, type WorkflowOperationElement } from "@cogwork/contracts";
import type { TriggerAdmission } from "./trigger-observation-admission";

export const operationKeyOf = (admission: TriggerAdmission, operation: string) => ({
  workflow: admission.subscription.workflow,
  operation,
});

export const handOffAdmission = (
  admission: TriggerAdmission,
  operation: TriggerAdmission["subscription"]["operation"],
  attempt: RunId,
) => ({
  ...admission,
  subscription: { ...admission.subscription, operation },
  lineage: {
    root: admission.lineage.root,
    parent: LineageId.make(attempt),
    hop: admission.lineage.hop + 1,
  },
});

export const parkedAdmission = (admission: TriggerAdmission, attempt: RunId): TriggerAdmission => ({
  ...admission,
  lineage: { ...admission.lineage, parent: LineageId.make(attempt) },
});

export const fanOutAdmission = (
  admission: TriggerAdmission,
  attempt: RunId,
  position: number,
  element: WorkflowOperationElement,
) => {
  const parent = keyOf(admission.event.key);
  return {
    event: {
      key: { _tag: "FanOutChild", parent, run: attempt, position },
      revision: `${admission.event.revision}:${attempt}:${position}`,
      cause: { _tag: "Cogwork", origin: parent, lineage: admission.lineage },
      atMillis: admission.event.atMillis,
      entry: admission.event.entry,
      workspace: admission.event.workspace,
      subject: admission.event.subject,
      workContext: {
        body: JSON.stringify(element, null, 2),
        comments: [],
      },
    },
    subscription: admission.subscription,
    lineage: {
      root: admission.lineage.root,
      parent: LineageId.make(attempt),
      hop: admission.lineage.hop + 1,
    },
  } satisfies TriggerAdmission;
};
