import type { WorkflowCatalogKey, WorkflowRecord } from "@cogwork/contracts";
import { matchesScheduledInstant } from "./clock-source";
import type { TriggerAdmission } from "./trigger-observation-admission";
import type { TriggerEvent, TriggerSource, TriggerSubscription } from "./trigger-source";

export const passesTriggerFilters = (subscription: TriggerSubscription, event: TriggerEvent) =>
  subscription.filters.every((filter) => event.passes?.includes(filter));

export const routeTriggerEvent = (subscriptions: ReadonlyArray<TriggerSubscription>, event: TriggerEvent) => {
  const observed = new Map((event.parameters ?? []).map(({ id, value }) => [id, value]));
  return subscriptions.filter((subscription) => {
    const sameScheduleWorkflow =
      event.key._tag !== "ScheduleInstant" || event.key.workflow === subscription.workflow;
    const sameWorkspace = event.workspace === null || subscription.workspaces.includes(event.workspace);
    const sameSchedule =
      event.key._tag !== "ScheduleInstant" || matchesScheduledInstant(subscription, event.key.instantMillis);
    const sameTarget =
      event.target === undefined ||
      (event.target.workflow === subscription.workflow && event.target.trigger === subscription.trigger);
    const sameParameters = [...observed].every(([id, value]) =>
      subscription.parameters.some((parameter) => parameter.id === id && parameter.value === value),
    );
    const afterCatchUp = subscription.catchUp === null || event.atMillis >= subscription.catchUp.since;
    return (
      subscription.entry === event.entry &&
      sameScheduleWorkflow &&
      sameWorkspace &&
      sameSchedule &&
      sameTarget &&
      sameParameters &&
      afterCatchUp
    );
  });
};

export const matchTriggerEvent = (subscriptions: ReadonlyArray<TriggerSubscription>, event: TriggerEvent) => {
  const matched = routeTriggerEvent(subscriptions, event).filter((subscription) =>
    passesTriggerFilters(subscription, event),
  );
  return event.key._tag === "ScheduleInstant" ? matched.slice(0, 1) : matched;
};

export const subscriptionsOf = (
  records: ReadonlyArray<WorkflowRecord>,
  everyWorkspace: ReadonlyArray<TriggerSubscription["workspaces"][number]>,
  conditionEntries: ReadonlySet<WorkflowCatalogKey>,
) =>
  records.flatMap((record) => {
    const document = record.publishedCopy;
    if (!record.enabled || document === null) return [];
    const workspaces =
      document.workspaces._tag === "Listed" ? document.workspaces.workspaces : everyWorkspace;
    return document.triggers.map(
      (trigger) =>
        ({
          workflow: record.id,
          trigger: trigger.id,
          operation: trigger.start,
          entry: trigger.entry,
          parameters: trigger.parameters,
          filters: trigger.filters.map(({ entry }) => entry),
          workspaces,
          catchUp: conditionEntries.has(trigger.entry) ? null : { since: 0 },
        }) satisfies TriggerSubscription,
    );
  });

export const startsSamePublishedTrigger = (
  published: TriggerSubscription,
  { subscription }: TriggerAdmission,
) =>
  published.workflow === subscription.workflow &&
  published.trigger === subscription.trigger &&
  published.entry === subscription.entry &&
  published.operation === subscription.operation;

export const sourceSubscriptions = (
  source: TriggerSource,
  subscriptions: ReadonlyArray<TriggerSubscription>,
) => {
  const entries = new Set(source.entries.map(({ key }) => key));
  return subscriptions.filter(({ entry }) => entries.has(entry));
};

export const subscriptionIdentity = ({
  workflow,
  trigger,
  operation,
  entry,
  parameters,
  filters,
  workspaces,
}: TriggerSubscription) =>
  JSON.stringify({ workflow, trigger, operation, entry, parameters, filters, workspaces });

export const fingerprintOf = (subscriptions: ReadonlyArray<TriggerSubscription>) =>
  JSON.stringify(
    subscriptions.map(({ workflow, trigger, operation, entry, parameters, filters, workspaces }) => ({
      workflow,
      trigger,
      operation,
      entry,
      parameters,
      filters,
      workspaces,
    })),
  );
