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

interface StoredAdmissionCount {
  readonly remaining: number;
}

export interface TriggerObservationStoreService {
  readonly admissions: Effect.Effect<ReadonlyArray<TriggerAdmission>, TriggerObservationStoreError>;
  readonly putAll: (
    admissions: ReadonlyArray<TriggerAdmission>,
  ) => Effect.Effect<void, TriggerObservationStoreError>;
  readonly complete: (admission: TriggerAdmission) => Effect.Effect<boolean, TriggerObservationStoreError>;
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
const sameRevision = (left: TriggerAdmission, right: TriggerAdmission) =>
  keyOf(left.event.key) === keyOf(right.event.key) && left.event.revision === right.event.revision;
const sourceRevisionKey = (admission: TriggerAdmission) =>
  JSON.stringify([keyOf(admission.event.key), admission.event.revision]);
const admissionIsOlder = (candidate: TriggerAdmission, current: TriggerAdmission) =>
  candidate.event.atMillis < current.event.atMillis ||
  (candidate.event.atMillis === current.event.atMillis && candidate.event.revision < current.event.revision);
const oldestRevisionAdmissions = (admissions: ReadonlyArray<TriggerAdmission>) => {
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
  const admissions = yield* Ref.make<{
    readonly pending: ReadonlyMap<string, TriggerAdmission>;
    readonly processed: ReadonlySet<string>;
  }>({ pending: new Map(), processed: new Set() });
  const checkpoints = yield* Ref.make<
    ReadonlyMap<string, { readonly active: boolean; readonly checkpointMillis: number }>
  >(new Map());
  return {
    admissions: Effect.map(Ref.get(admissions), (current) => [...current.pending.values()]),
    putAll: (batch) =>
      Ref.update(admissions, (current) => {
        const pending = batch.reduce((next, admission) => {
          const key = admissionKey(admission);
          return current.processed.has(key) ? next : new Map(next).set(key, admission);
        }, current.pending);
        return { ...current, pending };
      }).pipe(
        Effect.andThen(
          Ref.update(checkpoints, (current) => {
            return batch.reduce((next, admission) => {
              const key = subscriptionKey(admission.subscription);
              const checkpoint = next.get(key);
              if (!checkpoint) return next;
              return new Map(next).set(key, {
                ...checkpoint,
                checkpointMillis: Math.max(checkpoint.checkpointMillis, checkpointOf(admission)),
              });
            }, current);
          }),
        ),
      ),
    complete: (admission) =>
      Ref.modify(admissions, (current) => {
        const key = admissionKey(admission);
        const pending = new Map(current.pending);
        pending.delete(key);
        const processed = new Set(current.processed).add(key);
        const hasSibling = [...pending.values()].some((candidate) => sameRevision(candidate, admission));
        return [!hasSibling, { pending, processed }];
      }),
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
    admissions: sql<StoredAdmission>`SELECT payload FROM trigger_admissions WHERE processed = 0`.pipe(
      Effect.mapError(storeError),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, ({ payload }) => decodeAdmission(payload).pipe(Effect.mapError(storeError))),
      ),
    ),
    putAll: (admissions) =>
      controlStore
        .withWrite(
          sql.withTransaction(
            Effect.forEach(
              admissions,
              (admission) =>
                sql`
                  INSERT INTO trigger_admissions (work_item, revision, payload)
                  VALUES (
                    ${keyOf(admission.event.key)},
                    ${admission.event.revision},
                    ${encodeAdmission(admission)}
                  )
                  ON CONFLICT (work_item, revision, workflow, trigger)
                  DO UPDATE SET payload = excluded.payload
                `.pipe(
                  Effect.andThen(sql`
                    UPDATE trigger_subscription_checkpoints
                    SET checkpoint_millis = MAX(checkpoint_millis, ${checkpointOf(admission)})
                    WHERE workflow = ${admission.subscription.workflow}
                      AND trigger = ${admission.subscription.trigger}
                  `),
                ),
              { discard: true },
            ),
          ),
        )
        .pipe(Effect.asVoid, Effect.mapError(storeError)),
    complete: (admission) =>
      controlStore
        .withWrite(
          sql.withTransaction(
            sql`
              UPDATE trigger_admissions SET processed = 1
              WHERE work_item = ${keyOf(admission.event.key)}
                AND revision = ${admission.event.revision}
                AND workflow = ${admission.subscription.workflow}
                AND trigger = ${admission.subscription.trigger}
            `.pipe(
              Effect.andThen(sql<StoredAdmissionCount>`
                SELECT COUNT(*) AS remaining
                FROM trigger_admissions
                WHERE work_item = ${keyOf(admission.event.key)}
                  AND revision = ${admission.event.revision}
                  AND processed = 0
              `),
              Effect.map((rows) => rows[0]?.remaining === 0),
            ),
          ),
        )
        .pipe(Effect.mapError(storeError)),
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

  const admit = Effect.fn("TriggerObservation.admit")(function* (source: TriggerSource, event: TriggerEvent) {
    const listed = yield* workflows.list;
    const matched = matchTriggerEvent(subscriptionsOf(listed.workflows), event);
    if (matched.length === 0) return;
    const outcome = yield* coordination.observe(event.key, event.revision, event.cause);
    const current = outcome === "redelivered" ? yield* coordination.read(event.key) : null;
    const redeliveryIsClosed =
      current !== null &&
      (current.revision?.observed !== event.revision || current.revision.processed === event.revision);
    if (redeliveryIsClosed) return;
    const admissions = matched.map(
      (subscription) => ({ event, subscription, lineage: lineageOf(event.key) }) satisfies TriggerAdmission,
    );
    yield* store.putAll(admissions);
    yield* source.acknowledge?.(event, matched) ?? Effect.void;
    if (outcome === "redelivered") return;
    yield* Effect.forEach(admissions, (admission) => PubSub.publish(changes, admission), {
      discard: true,
    });
  });

  const observe = (
    source: TriggerSource,
    subscriptions: ReadonlyArray<TriggerSubscription>,
    fingerprint: string,
  ) =>
    source.observe(subscriptions).pipe(
      Stream.runForEach((event) => admit(source, event)),
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
        const oldest = oldestRevisionAdmissions(current);
        const active = oldest.filter(({ subscription }) => enabled.has(subscription.workflow));
        const inactive = oldest.filter(({ subscription }) => !enabled.has(subscription.workflow));
        const activeRevisions = new Set(active.map(sourceRevisionKey));
        const inactiveRevisions = [
          ...inactive
            .filter((admission) => !activeRevisions.has(sourceRevisionKey(admission)))
            .reduce(
              (revisions, admission) => new Map(revisions).set(sourceRevisionKey(admission), admission),
              new Map<string, TriggerAdmission>(),
            )
            .values(),
        ];
        return Effect.forEach(
          inactiveRevisions,
          (admission) => coordination.markProcessed(admission.event.key, admission.event.revision),
          { discard: true },
        ).pipe(
          Effect.andThen(Effect.forEach(inactive, store.complete, { discard: true })),
          Effect.andThen(
            Effect.forEach(active, (admission) =>
              coordination.read(admission.event.key).pipe(
                Effect.map((view) => ({
                  admission,
                  gate: view.gate({
                    workflow: admission.subscription.workflow,
                    operation: admission.subscription.operation,
                  }),
                })),
              ),
            ),
          ),
        );
      }),
      Effect.map((states) =>
        states.filter(({ gate }) => gate._tag === "Open").map(({ admission }) => admission),
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
