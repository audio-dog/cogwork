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
const decodeNotification = Schema.decodeUnknownOption(WorkflowNotificationSchema);

export interface WorkflowNotificationsService {
  readonly write: (run: RunRecord, notification: WorkflowNotification) => Effect.Effect<void, RunLedgerError>;
  readonly list: Effect.Effect<ReadonlyArray<WorkflowNotification>, RunLedgerError>;
}

export const make = Effect.gen(function* () {
  const ledger = yield* RunLedger;
  const recorder = yield* RunRecorder;
  return {
    write: (run, notification) =>
      recorder.record(run, { type: "CUSTOM", name: eventName, value: notification }).pipe(Effect.asVoid),
    list: ledger.listRuns(100).pipe(
      Effect.flatMap((runs) =>
        Effect.forEach(runs, (run) =>
          recorder.replay(run).pipe(
            Stream.runCollect,
            Effect.map((activities) =>
              activities.flatMap(({ event }) => {
                if (event.type !== "CUSTOM" || event.name !== eventName) return [];
                return Option.toArray(decodeNotification(event.value));
              }),
            ),
          ),
        ),
      ),
      Effect.map((notifications) => notifications.flat()),
    ),
  } satisfies WorkflowNotificationsService;
});

export const WorkflowNotifications = Context.Reference<WorkflowNotificationsService>(
  "@cogwork/engine/workflow-notification/WorkflowNotifications",
  { defaultValue: () => ({ write: () => Effect.void, list: Effect.succeed([]) }) },
);

export const layer = Layer.effect(WorkflowNotifications, make);
