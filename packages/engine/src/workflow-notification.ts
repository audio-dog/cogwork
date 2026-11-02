import {
  type RunRecord,
  type WorkflowNotification,
  WorkflowNotification as WorkflowNotificationSchema,
} from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { RunLedger, type RunLedgerError } from "./run-ledger";
import { RunRecorder } from "./run-recorder";

const eventName = "workflow.notification";
const dismissedEventName = "workflow.notification-dismissed";
const decodeNotification = Schema.decodeUnknownOption(WorkflowNotificationSchema);
const NotificationDismissed = Schema.Struct({ id: Schema.String });
const decodeDismissed = Schema.decodeUnknownOption(NotificationDismissed);

const eventReducers = [
  {
    name: eventName,
    reduce: (notifications: ReadonlyMap<string, WorkflowNotification>, value: unknown) =>
      Option.match(decodeNotification(value), {
        onNone: () => notifications,
        onSome: (notification) => new Map(notifications).set(notification.id, notification),
      }),
  },
  {
    name: dismissedEventName,
    reduce: (notifications: ReadonlyMap<string, WorkflowNotification>, value: unknown) =>
      Option.match(decodeDismissed(value), {
        onNone: () => notifications,
        onSome: ({ id }) => {
          const active = new Map(notifications);
          active.delete(id);
          return active;
        },
      }),
  },
] as const;

const notificationsIn = (recorder: Effect.Success<typeof RunRecorder>, run: RunRecord) =>
  recorder.replay(run).pipe(
    Stream.runCollect,
    Effect.map((activities) =>
      activities.reduce<ReadonlyMap<string, WorkflowNotification>>((notifications, { event }) => {
        if (event.type !== "CUSTOM") return notifications;
        const reducer = eventReducers.find(({ name }) => name === event.name);
        return reducer?.reduce(notifications, event.value) ?? notifications;
      }, new Map()),
    ),
  );

export interface WorkflowNotificationsService {
  readonly write: (run: RunRecord, notification: WorkflowNotification) => Effect.Effect<void, RunLedgerError>;
  readonly list: Effect.Effect<ReadonlyArray<WorkflowNotification>, RunLedgerError>;
  readonly dismiss: (id: string) => Effect.Effect<void, RunLedgerError>;
}

export const make = Effect.gen(function* () {
  const ledger = yield* RunLedger;
  const recorder = yield* RunRecorder;
  return {
    write: (run, notification) =>
      recorder.record(run, { type: "CUSTOM", name: eventName, value: notification }).pipe(Effect.asVoid),
    list: ledger.listRuns(Number.MAX_SAFE_INTEGER).pipe(
      Effect.flatMap((runs) => Effect.forEach(runs, (run) => notificationsIn(recorder, run))),
      Effect.map((notifications) => notifications.flatMap((active) => [...active.values()])),
    ),
    dismiss: (id) =>
      ledger.listRuns(Number.MAX_SAFE_INTEGER).pipe(
        Effect.flatMap((runs) =>
          Effect.forEach(runs, (run) =>
            notificationsIn(recorder, run).pipe(Effect.map((notifications) => ({ run, notifications }))),
          ),
        ),
        Effect.flatMap((active) => {
          const owner = active.find(({ notifications }) => notifications.has(id));
          if (!owner) return Effect.void;
          return recorder
            .record(owner.run, {
              type: "CUSTOM",
              name: dismissedEventName,
              value: { id },
            })
            .pipe(Effect.asVoid);
        }),
      ),
  } satisfies WorkflowNotificationsService;
});

export const WorkflowNotifications = Context.Reference<WorkflowNotificationsService>(
  "@cogwork/engine/workflow-notification/WorkflowNotifications",
  {
    defaultValue: () => ({
      write: () => Effect.void,
      list: Effect.succeed([]),
      dismiss: () => Effect.void,
    }),
  },
);

export const layer = Layer.effect(WorkflowNotifications, make);
