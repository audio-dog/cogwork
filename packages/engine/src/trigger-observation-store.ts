import { keyOf } from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";
import { ControlStore } from "./control-store";
import {
  admissionKey,
  checkpointOf,
  sameRevision,
  subscriptionKey,
  TriggerAdmission,
} from "./trigger-observation-admission";
import type { TriggerSubscription } from "./trigger-source";

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
  readonly processed: Effect.Effect<ReadonlyArray<TriggerAdmission>, TriggerObservationStoreError>;
  readonly putAll: (
    admissions: ReadonlyArray<TriggerAdmission>,
  ) => Effect.Effect<void, TriggerObservationStoreError>;
  readonly refreshPending: (
    admissions: ReadonlyArray<TriggerAdmission>,
  ) => Effect.Effect<void, TriggerObservationStoreError>;
  readonly complete: <E, R>(
    admission: TriggerAdmission,
    closeRevision: Effect.Effect<void, E, R>,
  ) => Effect.Effect<void, TriggerObservationStoreError | E, R>;
  readonly fanOut: <E, R>(
    admission: TriggerAdmission,
    children: ReadonlyArray<TriggerAdmission>,
    closeRevision: Effect.Effect<void, E, R>,
  ) => Effect.Effect<void, TriggerObservationStoreError | E, R>;
  readonly activate: (
    subscriptions: ReadonlyArray<TriggerSubscription>,
    atMillis: number,
  ) => Effect.Effect<ReadonlyArray<TriggerSubscription>, TriggerObservationStoreError>;
}

export class TriggerObservationStore extends Context.Service<
  TriggerObservationStore,
  TriggerObservationStoreService
>()("@cogwork/engine/trigger-observation-store/TriggerObservationStore") {}

const admissionJson = Schema.fromJsonString(TriggerAdmission);
const encodeAdmission = Schema.encodeSync(admissionJson);
const decodeAdmission = Schema.decodeUnknownEffect(admissionJson);
const storeError = (error: unknown) => new TriggerObservationStoreError({ message: String(error) });

const activateSubscriptions = (
  subscriptions: ReadonlyArray<TriggerSubscription>,
  checkpoints: ReadonlyMap<string, { readonly active: boolean; readonly checkpointMillis: number }>,
  atMillis: number,
) =>
  subscriptions.map((subscription) => {
    if (subscription.catchUp === null) return subscription;
    const checkpoint = checkpoints.get(subscriptionKey(subscription));
    const since = checkpoint?.active ? checkpoint.checkpointMillis : atMillis;
    return { ...subscription, catchUp: { since } };
  });

export const makeMemoryTriggerObservationStore = Effect.gen(function* () {
  const admissions = yield* Ref.make<{
    readonly pending: ReadonlyMap<string, TriggerAdmission>;
    readonly processed: ReadonlyMap<string, TriggerAdmission>;
  }>({ pending: new Map(), processed: new Map() });
  const checkpoints = yield* Ref.make<
    ReadonlyMap<string, { readonly active: boolean; readonly checkpointMillis: number }>
  >(new Map());
  const completionGate = Semaphore.makeUnsafe(1);
  const putAll = (batch: ReadonlyArray<TriggerAdmission>) =>
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
    );
  const finish = (admission: TriggerAdmission) =>
    Ref.update(admissions, (current) => {
      const key = admissionKey(admission);
      const pending = new Map(current.pending);
      pending.delete(key);
      return { pending, processed: new Map(current.processed).set(key, admission) };
    });
  const refreshPending = (batch: ReadonlyArray<TriggerAdmission>) =>
    Ref.update(admissions, (current) => {
      const pending = batch.reduce((next, admission) => {
        const key = admissionKey(admission);
        return next.has(key) ? new Map(next).set(key, admission) : next;
      }, current.pending);
      return { ...current, pending };
    });
  return {
    admissions: Effect.map(Ref.get(admissions), (current) => [...current.pending.values()]),
    processed: Effect.map(Ref.get(admissions), (current) => [...current.processed.values()]),
    putAll: (batch) => completionGate.withPermit(putAll(batch)),
    refreshPending: (batch) => completionGate.withPermit(refreshPending(batch)),
    complete: (admission, closeRevision) =>
      completionGate.withPermit(
        Ref.get(admissions).pipe(
          Effect.flatMap((current) => {
            const hasSibling = [...current.pending.values()].some(
              (candidate) =>
                admissionKey(candidate) !== admissionKey(admission) && sameRevision(candidate, admission),
            );
            const beforeFinish = hasSibling ? Effect.void : closeRevision;
            return beforeFinish.pipe(Effect.andThen(finish(admission)));
          }),
        ),
      ),
    fanOut: (admission, children, closeRevision) =>
      completionGate.withPermit(
        Effect.uninterruptible(
          Ref.get(admissions).pipe(
            Effect.flatMap((current) => {
              const hasSibling = [...current.pending.values()].some(
                (candidate) =>
                  admissionKey(candidate) !== admissionKey(admission) && sameRevision(candidate, admission),
              );
              const beforeFinish = hasSibling ? Effect.void : closeRevision;
              return putAll(children).pipe(Effect.andThen(beforeFinish), Effect.andThen(finish(admission)));
            }),
          ),
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
  const completionGate = Semaphore.makeUnsafe(1);
  const putStatements = (admissions: ReadonlyArray<TriggerAdmission>) =>
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
    );
  const putAll = (admissions: ReadonlyArray<TriggerAdmission>) =>
    controlStore
      .withWrite(sql.withTransaction(putStatements(admissions)))
      .pipe(Effect.asVoid, Effect.mapError(storeError));
  const finishStatement = (admission: TriggerAdmission) =>
    sql`
        UPDATE trigger_admissions SET processed = 1
        WHERE work_item = ${keyOf(admission.event.key)}
          AND revision = ${admission.event.revision}
          AND workflow = ${admission.subscription.workflow}
          AND trigger = ${admission.subscription.trigger}
      `.pipe(Effect.asVoid);
  const refreshPending = (admissions: ReadonlyArray<TriggerAdmission>) =>
    controlStore
      .withWrite(
        Effect.forEach(
          admissions,
          (admission) => sql`
            UPDATE trigger_admissions SET payload = ${encodeAdmission(admission)}
            WHERE work_item = ${keyOf(admission.event.key)}
              AND revision = ${admission.event.revision}
              AND workflow = ${admission.subscription.workflow}
              AND trigger = ${admission.subscription.trigger}
              AND processed = 0
          `,
          { discard: true },
        ),
      )
      .pipe(Effect.mapError(storeError));
  const finish = (admission: TriggerAdmission) =>
    controlStore.withWrite(finishStatement(admission)).pipe(Effect.mapError(storeError));
  const closeAndFinish = <E, R>(admission: TriggerAdmission, closeRevision: Effect.Effect<void, E, R>) =>
    sql
      .withTransaction(closeRevision.pipe(Effect.andThen(finishStatement(admission))))
      .pipe(Effect.mapError((error) => (SqlError.isSqlError(error) ? storeError(error) : error)));
  return {
    admissions: sql<StoredAdmission>`SELECT payload FROM trigger_admissions WHERE processed = 0`.pipe(
      Effect.mapError(storeError),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, ({ payload }) => decodeAdmission(payload).pipe(Effect.mapError(storeError))),
      ),
    ),
    processed: sql<StoredAdmission>`SELECT payload FROM trigger_admissions WHERE processed = 1`.pipe(
      Effect.mapError(storeError),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, ({ payload }) => decodeAdmission(payload).pipe(Effect.mapError(storeError))),
      ),
    ),
    putAll: (admissions) => completionGate.withPermit(putAll(admissions)),
    refreshPending: (admissions) => completionGate.withPermit(refreshPending(admissions)),
    complete: (admission, closeRevision) =>
      completionGate.withPermit(
        sql<StoredAdmissionCount>`
          SELECT COUNT(*) AS remaining
          FROM trigger_admissions
          WHERE work_item = ${keyOf(admission.event.key)}
            AND revision = ${admission.event.revision}
            AND processed = 0
            AND NOT (
              workflow = ${admission.subscription.workflow}
              AND trigger = ${admission.subscription.trigger}
            )
        `.pipe(
          Effect.mapError(storeError),
          Effect.flatMap((rows) => {
            const hasSibling = (rows[0]?.remaining ?? 0) > 0;
            return hasSibling ? finish(admission) : closeAndFinish(admission, closeRevision);
          }),
        ),
      ),
    fanOut: (admission, children, closeRevision) =>
      completionGate.withPermit(
        sql<StoredAdmissionCount>`
          SELECT COUNT(*) AS remaining
          FROM trigger_admissions
          WHERE work_item = ${keyOf(admission.event.key)}
            AND revision = ${admission.event.revision}
            AND processed = 0
            AND NOT (
              workflow = ${admission.subscription.workflow}
              AND trigger = ${admission.subscription.trigger}
            )
        `.pipe(
          Effect.flatMap((rows) => {
            const hasSibling = (rows[0]?.remaining ?? 0) > 0;
            const beforeFinish = hasSibling ? Effect.void : closeRevision;
            return sql.withTransaction(
              putStatements(children).pipe(
                Effect.andThen(beforeFinish),
                Effect.andThen(finishStatement(admission)),
              ),
            );
          }),
          Effect.mapError((error) => (SqlError.isSqlError(error) ? storeError(error) : error)),
        ),
      ),
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
