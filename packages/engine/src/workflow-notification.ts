import type { WorkflowNotification } from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

export interface WorkflowNotificationsService {
  readonly write: (notification: WorkflowNotification) => Effect.Effect<void>;
  readonly list: Effect.Effect<ReadonlyArray<WorkflowNotification>>;
}

export const make = Effect.gen(function* () {
  const notifications = yield* Ref.make<ReadonlyArray<WorkflowNotification>>([]);
  return {
    write: (notification) => Ref.update(notifications, (current) => [notification, ...current]),
    list: Ref.get(notifications),
  } satisfies WorkflowNotificationsService;
});

export const WorkflowNotifications = Context.Reference<WorkflowNotificationsService>(
  "@cogwork/engine/workflow-notification/WorkflowNotifications",
  { defaultValue: () => ({ write: () => Effect.void, list: Effect.succeed([]) }) },
);

export const layer = Layer.effect(WorkflowNotifications, make);
