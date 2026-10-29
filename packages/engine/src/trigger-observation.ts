import {
  DaemonEvent,
  keyOf,
  Lineage,
  LineageId,
  type WorkflowCatalog,
  type WorkflowRecord,
  type WorkItemRef,
} from "@cogwork/contracts";
import * as EffectCause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { matchesScheduledInstant } from "./clock-source";
import { ControlStore } from "./control-store";
import { Coordination } from "./coordination";
import { DaemonEventBus } from "./daemon-event-bus";
import {
  type SourceFailure,
  TriggerEvent,
  type TriggerSource,
  TriggerSources,
  TriggerSubscription,
} from "./trigger-source";
import { Workflows } from "./workflow";

export const TriggerAdmission = Schema.Struct({
  event: TriggerEvent,
  subscription: TriggerSubscription,
  lineage: Lineage,
});
export type TriggerAdmission = typeof TriggerAdmission.Type;

export class TriggerObservationStoreError extends Schema.TaggedError<TriggerObservationStoreError>()(
  "TriggerObservationStoreError",
  { message: Schema.String },
) {}

interface StoredCheckpoint {
  readonly workflow: string;
  readonly trigger: string;
  readonly active: number;
  readonly checkpointMillis: number;
}

interface StoredAdmission {
  readonly payload: string;
}

export interface TriggerObservationStoreService {
  readonly admissions: Effect.Effect<ReadonlyArray<TriggerAdmission>, TriggerObservationStoreError>;
  readonly put: (admission: TriggerAdmission) => Effect.Effect<void, TriggerObservationStoreError>;
  readonly activate: (
    subscriptions: ReadonlyArray<TriggerSubscription>,
    atMillis: number,
  ) => Effect.Effect<ReadonlyArray<TriggerSubscription>, TriggerObservationStoreError>;
}

export class TriggerObservationStore extends Context.Service<
  TriggerObservationStore,
  TriggerObservationStoreService
>()("@cogwork/engine/trigger-observation/TriggerObservationStore") {}

const admissionJson = Schema.fromJsonString(TriggerAdmission);
const encodeAdmission = Schema.encodeSync(admissionJson);
const decodeAdmission = Schema.decodeUnknownEffect(admissionJson);
const storeError = (error: unknown) => new TriggerObservationStoreError({ message: String(error) });
const subscriptionKey = ({ workflow, trigger }: TriggerSubscription) => `${workflow}:${trigger}`;
const admissionKey = (admission: TriggerAdmission) =>
  `${keyOf(admission.event.key)}:${admission.event.revision}:${subscriptionKey(admission.subscription)}`;
const checkpointOf = (admission: TriggerAdmission) =>
  admission.event.key._tag === "ScheduleInstant"
    ? admission.event.key.instantMillis
    : admission.event.atMillis;

const activateSubscriptions = (
  subscriptions: ReadonlyArray<TriggerSubscription>,
  checkpoints: ReadonlyMap<string, { readonly active: boolean; readonly checkpointMillis: number }>,
  atMillis: number,
) =>
  subscriptions.map((subscription) => {
    const checkpoint = checkpoints.get(subscriptionKey(subscription));
    const since = checkpoint?.active ? checkpoint.checkpointMillis : atMillis;
    return { ...subscription, catchUp: { since } };
  });

export const makeMemoryTriggerObservationStore = Effect.gen(function* () {
  const admissions = yield* Ref.make<ReadonlyMap<string, TriggerAdmission>>(new Map());
  const checkpoints = yield* Ref.make<
    ReadonlyMap<string, { readonly active: boolean; readonly checkpointMillis: number }>
  >(new Map());
  return {
    admissions: Effect.map(Ref.get(admissions), (current) => [...current.values()]),
    put: (admission) =>
      Ref.update(admissions, (current) => new Map(current).set(admissionKey(admission), admission)).pipe(
        Effect.andThen(
          Ref.update(checkpoints, (current) => {
            const key = subscriptionKey(admission.subscription);
            const checkpoint = current.get(key);
            if (!checkpoint) return current;
            return new Map(current).set(key, {
              ...checkpoint,
              checkpointMillis: Math.max(checkpoint.checkpointMillis, checkpointOf(admission)),
            });
          }),
        ),
      ),
    activate: (subscriptions, atMillis) =>
      Ref.modify(checkpoints, (current) => {
        const activated = activateSubscriptions(subscriptions, current, atMillis);
        const activeKeys = new Set(subscriptions.map(subscriptionKey));
        const inactive = [...current].map(
          ([key, value]) =>
            [key, activeKeys.has(key) ? value : { active: false, checkpointMillis: atMillis }] as const,
        );
        const next = activated.reduce(
          (result, subscription) =>
            result.set(subscriptionKey(subscription), {
              active: true,
              checkpointMillis: subscription.catchUp?.since ?? atMillis,
            }),
          new Map(inactive),
        );
        return [activated, next];
      }),
  } satisfies TriggerObservationStoreService;
});

export const memoryTriggerObservationStoreLayer = Layer.effect(
  TriggerObservationStore,
  makeMemoryTriggerObservationStore,
);

export const makeControlStoreTriggerObservationStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const controlStore = yield* ControlStore;
  return {
    admissions: sql<StoredAdmission>`SELECT payload FROM trigger_admissions`.pipe(
      Effect.mapError(storeError),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, ({ payload }) => decodeAdmission(payload).pipe(Effect.mapError(storeError))),
      ),
    ),
    put: (admission) =>
      controlStore
        .withWrite(
          sql.withTransaction(
            sql`
              INSERT INTO trigger_admissions (work_item, revision, workflow, trigger, payload)
              VALUES (
                ${keyOf(admission.event.key)},
                ${admission.event.revision},
                ${admission.subscription.workflow},
                ${admission.subscription.trigger},
                ${encodeAdmission(admission)}
              )
              ON CONFLICT (work_item, revision, workflow, trigger) DO UPDATE SET payload = excluded.payload
            `.pipe(
              Effect.andThen(sql`
                UPDATE trigger_subscription_checkpoints
                SET checkpoint_millis = MAX(checkpoint_millis, ${checkpointOf(admission)})
                WHERE workflow = ${admission.subscription.workflow}
                  AND trigger = ${admission.subscription.trigger}
              `),
            ),
          ),
        )
        .pipe(Effect.asVoid, Effect.mapError(storeError)),
    activate: (subscriptions, atMillis) =>
      controlStore
        .withWrite(
          sql.withTransaction(
            sql<StoredCheckpoint>`
                SELECT workflow, trigger, active, checkpoint_millis AS checkpointMillis
                FROM trigger_subscription_checkpoints
              `.pipe(
              Effect.flatMap((rows) => {
                const checkpoints = new Map(
                  rows.map(({ workflow, trigger, active, checkpointMillis }) => [
                    `${workflow}:${trigger}`,
                    { active: active === 1, checkpointMillis },
                  ]),
                );
                const activated = activateSubscriptions(subscriptions, checkpoints, atMillis);
                return sql`
                  UPDATE trigger_subscription_checkpoints
                  SET active = 0, checkpoint_millis = ${atMillis}
                `.pipe(
                  Effect.andThen(
                    Effect.forEach(
                      activated,
                      (subscription) => sql`
                  INSERT INTO trigger_subscription_checkpoints
                    (workflow, trigger, active, checkpoint_millis)
                  VALUES (${subscription.workflow}, ${subscription.trigger}, 1, ${subscription.catchUp?.since ?? atMillis})
                  ON CONFLICT (workflow, trigger) DO UPDATE SET
                    active = 1,
                    checkpoint_millis = excluded.checkpoint_millis
                `,
                      { discard: true },
                    ),
                  ),
                  Effect.map(() => activated),
                );
              }),
            ),
          ),
        )
        .pipe(Effect.mapError(storeError)),
  } satisfies TriggerObservationStoreService;
});

export const controlStoreTriggerObservationStoreLayer = Layer.effect(
  TriggerObservationStore,
  makeControlStoreTriggerObservationStore,
);

export interface TriggerSourceHealth {
  readonly source: TriggerSource["id"];
  readonly status: "idle" | "observing" | "failed";
  readonly message: string | null;
}

export const matchTriggerEvent = (subscriptions: ReadonlyArray<TriggerSubscription>, event: TriggerEvent) => {
  const matched = subscriptions.filter((subscription) => {
    const sameScheduleWorkflow =
      event.key._tag !== "ScheduleInstant" || event.key.workflow === subscription.workflow;
    const sameWorkspace = event.workspace === null || subscription.workspaces.includes(event.workspace);
    const sameSchedule =
      event.key._tag !== "ScheduleInstant" || matchesScheduledInstant(subscription, event.key.instantMillis);
    const sameParameters =
      event.parameters === undefined ||
      (subscription.parameters.length === event.parameters.length &&
        subscription.parameters.every((parameter) =>
          event.parameters?.some(
            (candidate) => candidate.id === parameter.id && candidate.value === parameter.value,
          ),
        ));
    return (
      subscription.entry === event.entry &&
      sameScheduleWorkflow &&
      sameWorkspace &&
      sameSchedule &&
      sameParameters
    );
  });
  return event.key._tag === "ScheduleInstant" ? matched.slice(0, 1) : matched;
};

const subscriptionsOf = (records: ReadonlyArray<WorkflowRecord>) =>
  records.flatMap((record) => {
    const document = record.publishedCopy;
    if (!record.enabled || document === null) return [];
    const workspaces = document.workspaces._tag === "Listed" ? document.workspaces.workspaces : [];
    return document.triggers.map(
      (trigger) =>
        ({
          workflow: record.id,
          trigger: trigger.id,
          operation: trigger.start,
          entry: trigger.entry,
          parameters: trigger.parameters,
          workspaces,
          catchUp: { since: 0 },
        }) satisfies TriggerSubscription,
    );
  });

const sourceSubscriptions = (source: TriggerSource, subscriptions: ReadonlyArray<TriggerSubscription>) => {
  const entries = new Set(source.entries.map(({ key }) => key));
  return subscriptions.filter(({ entry }) => entries.has(entry));
};

const fingerprintOf = (subscriptions: ReadonlyArray<TriggerSubscription>) =>
  JSON.stringify(
    subscriptions.map(({ workflow, trigger, operation, entry, parameters, workspaces }) => ({
      workflow,
      trigger,
      operation,
      entry,
      parameters,
      workspaces,
    })),
  );

const lineageOf = (ref: WorkItemRef): Lineage => ({
  root: Schema.decodeSync(LineageId)(keyOf(ref)),
  parent: null,
  hop: 0,
});

const waitForRetry = (failure: SourceFailure) => {
  const retryRules = [
    { matches: failure.reason === "connection-not-ready", wait: Effect.never },
    { matches: failure.retryAfterMillis === null, wait: Effect.void },
  ];
  return retryRules.find(({ matches }) => matches)?.wait ?? Effect.sleep(failure.retryAfterMillis ?? 0);
};

export interface TriggerObservationService {
  readonly eligible: Effect.Effect<ReadonlyArray<TriggerAdmission>>;
  readonly changes: Stream.Stream<TriggerAdmission>;
  readonly health: Effect.Effect<ReadonlyArray<TriggerSourceHealth>>;
  readonly catalog: WorkflowCatalog["entries"];
  readonly refresh: Effect.Effect<void>;
}

export const make = Effect.gen(function* () {
  const workflows = yield* Workflows;
  const coordination = yield* Coordination;
  const bus = yield* DaemonEventBus;
  const store = yield* TriggerObservationStore;
  const sources = yield* TriggerSources;
  const fibers = yield* FiberMap.make<TriggerSource["id"]>();
  const fingerprints = yield* Ref.make<ReadonlyMap<TriggerSource["id"], string>>(new Map());
  const health = yield* Ref.make<ReadonlyMap<TriggerSource["id"], TriggerSourceHealth>>(
    new Map(sources.map(({ id }) => [id, { source: id, status: "idle", message: null }])),
  );
  const changes = yield* PubSub.unbounded<TriggerAdmission>();
  const refreshGate = Semaphore.makeUnsafe(1);

  const setHealth = (
    source: TriggerSource["id"],
    status: TriggerSourceHealth["status"],
    message: string | null,
  ) => Ref.update(health, (current) => new Map(current).set(source, { source, status, message }));

  const admit = Effect.fn("TriggerObservation.admit")(function* (event: TriggerEvent) {
    const listed = yield* workflows.list;
    const matched = matchTriggerEvent(subscriptionsOf(listed.workflows), event);
    if (matched.length === 0) return;
    const outcome = yield* coordination.observe(event.key, event.revision, event.cause);
    if (outcome === "redelivered") return;
    yield* Effect.forEach(matched, (subscription) => {
      const admission = { event, subscription, lineage: lineageOf(event.key) } satisfies TriggerAdmission;
      return store.put(admission).pipe(Effect.andThen(PubSub.publish(changes, admission)), Effect.asVoid);
    });
  });

  const observe = (
    source: TriggerSource,
    subscriptions: ReadonlyArray<TriggerSubscription>,
    fingerprint: string,
  ) =>
    source.observe(subscriptions).pipe(
      Stream.runForEach(admit),
      Effect.catchTag("SourceFailure", (error: SourceFailure) =>
        setHealth(source.id, "failed", error.message).pipe(Effect.andThen(waitForRetry(error))),
      ),
      Effect.catchCause((cause) =>
        EffectCause.hasInterruptsOnly(cause)
          ? Effect.void
          : setHealth(source.id, "failed", EffectCause.pretty(cause)),
      ),
      Effect.ensuring(
        Ref.update(fingerprints, (current) => {
          if (current.get(source.id) !== fingerprint) return current;
          const next = new Map(current);
          next.delete(source.id);
          return next;
        }),
      ),
    );

  const syncSource = Effect.fn("TriggerObservation.syncSource")(function* (
    source: TriggerSource,
    subscriptions: ReadonlyArray<TriggerSubscription>,
  ) {
    const nextFingerprint = fingerprintOf(subscriptions);
    const currentFingerprint = (yield* Ref.get(fingerprints)).get(source.id);
    if (currentFingerprint === nextFingerprint) return;
    yield* Ref.update(fingerprints, (current) => new Map(current).set(source.id, nextFingerprint));
    if (subscriptions.length === 0) {
      yield* FiberMap.remove(fibers, source.id);
      yield* source.observe([]).pipe(Stream.runDrain, Effect.ignore);
      yield* setHealth(source.id, "idle", null);
      return;
    }
    yield* setHealth(source.id, "observing", null);
    yield* FiberMap.run(fibers, source.id, observe(source, subscriptions, nextFingerprint));
  });

  const refresh = () =>
    refreshGate.withPermit(
      workflows.list.pipe(
        Effect.flatMap((listed) =>
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((atMillis) => store.activate(subscriptionsOf(listed.workflows), atMillis)),
            Effect.flatMap((subscriptions) =>
              Effect.forEach(
                sources,
                (source) => syncSource(source, sourceSubscriptions(source, subscriptions)),
                { discard: true },
              ),
            ),
          ),
        ),
        Effect.catchCause((cause) => Effect.logError("trigger subscription refresh failed", { cause })),
      ),
    );

  const workflowChanged = (event: DaemonEvent) =>
    DaemonEvent.guards.WorkflowChanged(event) || DaemonEvent.guards.WorkflowDeleted(event);
  const subscriptionsChanged = (event: DaemonEvent) =>
    workflowChanged(event) || DaemonEvent.guards.ConnectionsChanged(event);
  function resetFailedSources() {
    return Ref.get(health).pipe(
      Effect.map((current) => [...current.values()].filter(({ status }) => status === "failed")),
      Effect.flatMap((failed) => {
        const failedIds = new Set(failed.map(({ source }) => source));
        return Effect.forEach(failed, ({ source }) => FiberMap.remove(fibers, source), {
          discard: true,
        }).pipe(
          Effect.andThen(
            Ref.update(
              fingerprints,
              (current) => new Map([...current].filter(([source]) => !failedIds.has(source))),
            ),
          ),
        );
      }),
    );
  }
  yield* Effect.forkScoped(
    Effect.all(
      [
        refresh().pipe(Effect.repeat(Schedule.spaced("5 seconds"))),
        bus.events.pipe(
          Stream.filter(subscriptionsChanged),
          Stream.runForEach((event) =>
            (DaemonEvent.guards.ConnectionsChanged(event) ? resetFailedSources() : Effect.void).pipe(
              Effect.andThen(refresh),
            ),
          ),
        ),
      ],
      { concurrency: "unbounded", discard: true },
    ),
  );

  return {
    eligible: Effect.all([workflows.list, store.admissions]).pipe(
      Effect.flatMap(([listed, current]) => {
        const enabled = new Set(listed.workflows.filter(({ enabled }) => enabled).map(({ id }) => id));
        return Effect.forEach(current, (admission) =>
          coordination.read(admission.event.key).pipe(
            Effect.map((view) => ({
              admission,
              enabled: enabled.has(admission.subscription.workflow),
              gate: view.gate({
                workflow: admission.subscription.workflow,
                operation: admission.subscription.operation,
              }),
            })),
          ),
        );
      }),
      Effect.map((states) =>
        states
          .filter(({ enabled, gate }) => enabled && gate._tag === "Open")
          .map(({ admission }) => admission),
      ),
      Effect.catchCause(() => Effect.succeed([])),
    ),
    changes: Stream.fromPubSub(changes),
    health: Effect.map(Ref.get(health), (current) => [...current.values()]),
    catalog: sources.flatMap(({ entries }) => entries),
    refresh: refresh(),
  } satisfies TriggerObservationService;
});

const unavailableObservation: TriggerObservationService = {
  eligible: Effect.succeed([]),
  changes: Stream.empty,
  health: Effect.succeed([]),
  catalog: [],
  refresh: Effect.void,
};

export const TriggerObservation = Context.Reference<TriggerObservationService>(
  "@cogwork/engine/trigger-observation/TriggerObservation",
  { defaultValue: () => unavailableObservation },
);

export const layer = Layer.effect(TriggerObservation, make);
