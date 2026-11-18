import {
  type ControlStoreFailure,
  DaemonEvent,
  defaultPriority,
  keyOf,
  Lineage,
  LineageId,
  type ParkReason,
  priorityRank,
  type TriggerSourceHealth,
  type WorkflowCatalog,
  type WorkflowCatalogKey,
  type WorkflowDocument,
  type WorkflowRecord,
  WorkItemId,
  WorkItemRef,
  type WorkspaceId,
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
import * as SqlError from "effect/unstable/sql/SqlError";
import { matchesScheduledInstant, sweepKey } from "./clock-source";
import { ControlStore } from "./control-store";
import { Coordination } from "./coordination";
import { DaemonEventBus } from "./daemon-event-bus";
import { IssueTracker } from "./issue-tracker";
import { providerSubject } from "./provider-trigger-source";
import { WorkspaceRegistry } from "./registry";
import {
  ownsEntry,
  Recheck,
  SourceFailure,
  type SweepCandidate,
  TriggerEvent,
  type TriggerReadPort,
  type TriggerSource,
  TriggerSources,
  TriggerSubscription,
} from "./trigger-source";
import { Workflows } from "./workflow";
import { pullMatchesLinkKey } from "./worktree";

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

interface AssigneeSnapshot {
  readonly atMillis: number;
  readonly assignees: ReadonlyMap<WorkItemId, ReadonlyArray<string>>;
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
>()("@cogwork/engine/trigger-observation/TriggerObservationStore") {}

const admissionJson = Schema.fromJsonString(TriggerAdmission);
const encodeAdmission = Schema.encodeSync(admissionJson);
const decodeTriggerEvent = Schema.decodeUnknownEffect(TriggerEvent);
const decodeAdmission = Schema.decodeUnknownEffect(admissionJson);
const storeError = (error: unknown) => new TriggerObservationStoreError({ message: String(error) });
const subscriptionKey = ({ workflow, trigger }: TriggerSubscription) => `${workflow}:${trigger}`;
const admissionKey = (admission: TriggerAdmission) =>
  `${keyOf(admission.event.key)}:${admission.event.revision}:${subscriptionKey(admission.subscription)}`;
const sameRevision = (left: TriggerAdmission, right: TriggerAdmission) =>
  keyOf(left.event.key) === keyOf(right.event.key) && left.event.revision === right.event.revision;
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

interface WaitingAdmission {
  readonly admission: TriggerAdmission;
  readonly actedOn: boolean;
}

const waitingAdmissionOrder = (left: WaitingAdmission, right: WaitingAdmission) =>
  Number(right.actedOn) - Number(left.actedOn) ||
  priorityRank.indexOf(left.admission.event.priority ?? defaultPriority) -
    priorityRank.indexOf(right.admission.event.priority ?? defaultPriority) ||
  left.admission.event.atMillis - right.admission.event.atMillis;

const revisionAdvancedParks = new Set<ParkReason["_tag"]>([
  "AwaitingApproval",
  "MissingOperation",
  "PlanRejected",
]);

const sameSubscription = (left: TriggerAdmission, right: TriggerAdmission) =>
  keyOf(left.event.key) === keyOf(right.event.key) &&
  left.subscription.workflow === right.subscription.workflow &&
  left.subscription.trigger === right.subscription.trigger;
const checkpointOf = (admission: TriggerAdmission) =>
  admission.event.key._tag === "ScheduleInstant"
    ? admission.event.key.instantMillis
    : admission.event.atMillis;
const assigneeSnapshotTtl = 60_000;
const trackerSystems = ["github", "linear"] as const;
const ungated = () => Effect.succeed(true);
const freshAssignees = (snapshot: AssigneeSnapshot | undefined, now: number) =>
  snapshot && now - snapshot.atMillis < assigneeSnapshotTtl ? snapshot.assignees : null;

const trackerSystemsOf = (document: WorkflowDocument | null) =>
  new Set(
    document?.operations.flatMap(({ transitions }) =>
      transitions.flatMap(({ actions }) =>
        actions.flatMap(({ entry }) => trackerSystems.filter((system) => entry.startsWith(`${system}.`))),
      ),
    ) ?? [],
  );

const subscriptionParameter = (subscription: TriggerSubscription, id: string) =>
  subscription.parameters.find((parameter) => parameter.id === id)?.value;

const sweepFailure = (error: unknown) =>
  new SourceFailure({
    source: "clock",
    reason: "unavailable",
    retryAfterMillis: null,
    message: error instanceof Error ? error.message : String(error),
  });

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
  return {
    admissions: Effect.map(Ref.get(admissions), (current) => [...current.pending.values()]),
    processed: Effect.map(Ref.get(admissions), (current) => [...current.processed.values()]),
    putAll: (batch) => completionGate.withPermit(putAll(batch)),
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

export const matchTriggerEvent = (subscriptions: ReadonlyArray<TriggerSubscription>, event: TriggerEvent) => {
  const observed = new Map((event.parameters ?? []).map(({ id, value }) => [id, value]));
  const matched = subscriptions.filter((subscription) => {
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
    const passesFilters = subscription.filters.every((filter) => event.passes?.includes(filter));
    return (
      subscription.entry === event.entry &&
      sameScheduleWorkflow &&
      sameWorkspace &&
      sameSchedule &&
      sameTarget &&
      sameParameters &&
      afterCatchUp &&
      passesFilters
    );
  });
  return event.key._tag === "ScheduleInstant" ? matched.slice(0, 1) : matched;
};

const subscriptionsOf = (
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

const startsSamePublishedTrigger = (published: TriggerSubscription, { subscription }: TriggerAdmission) =>
  published.workflow === subscription.workflow &&
  published.trigger === subscription.trigger &&
  published.entry === subscription.entry &&
  published.operation === subscription.operation;

const sourceSubscriptions = (source: TriggerSource, subscriptions: ReadonlyArray<TriggerSubscription>) => {
  const entries = new Set(source.entries.map(({ key }) => key));
  return subscriptions.filter(({ entry }) => entries.has(entry));
};

const subscriptionIdentity = ({
  workflow,
  trigger,
  operation,
  entry,
  parameters,
  filters,
  workspaces,
}: TriggerSubscription) =>
  JSON.stringify({ workflow, trigger, operation, entry, parameters, filters, workspaces });

const fingerprintOf = (subscriptions: ReadonlyArray<TriggerSubscription>) =>
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

const lineageOf = (event: TriggerEvent): Lineage => {
  const root = event.cause._tag === "Clock" ? `${keyOf(event.key)}:${event.revision}` : keyOf(event.key);
  const current = Schema.decodeSync(LineageId)(root);
  if (event.cause._tag !== "Cogwork") return { root: current, parent: null, hop: 0 };
  return {
    root: event.cause.lineage.root,
    parent: Schema.decodeSync(LineageId)(event.cause.origin),
    hop: event.cause.lineage.hop + 1,
  };
};

const planRejectionOf = (event: TriggerEvent) =>
  event.payload?._tag === "GranolaNoteRejected"
    ? ({ _tag: "PlanRejected", reason: event.payload.reason, entry: event.entry } satisfies ParkReason)
    : null;

const samePlanRejection = (left: ParkReason | undefined, right: ParkReason | null) =>
  left?._tag === "PlanRejected" &&
  right?._tag === "PlanRejected" &&
  left.reason === right.reason &&
  left.entry === right.entry;

const waitForRetry = (failure: SourceFailure) => {
  const retryRules = [
    { matches: failure.reason === "connection-not-ready", wait: Effect.never },
    { matches: failure.retryAfterMillis === null, wait: Effect.void },
  ];
  return retryRules.find(({ matches }) => matches)?.wait ?? Effect.sleep(failure.retryAfterMillis ?? 0);
};

export interface TriggerObservationService {
  readonly eligible: Effect.Effect<ReadonlyArray<TriggerAdmission>>;
  readonly recheck: (admission: TriggerAdmission) => Effect.Effect<Recheck, ControlStoreFailure>;
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
  const conditionEntries = new Set(
    sources.flatMap(({ entries }) =>
      entries.filter(({ triggerKind }) => triggerKind === "condition").map(({ key }) => key),
    ),
  );
  const tracker = yield* IssueTracker;
  const registry = yield* WorkspaceRegistry;
  const fibers = yield* FiberMap.make<TriggerSource["id"]>();
  const fingerprints = yield* Ref.make<ReadonlyMap<TriggerSource["id"], string>>(new Map());
  const health = yield* Ref.make<ReadonlyMap<TriggerSource["id"], TriggerSourceHealth>>(
    new Map(sources.map(({ id }) => [id, { source: id, status: "idle", message: null }])),
  );
  const changes = yield* PubSub.unbounded<TriggerAdmission>();
  const refreshGate = Semaphore.makeUnsafe(1);
  const assigneeGate = Semaphore.makeUnsafe(1);
  const assigneeSnapshots = yield* Ref.make<ReadonlyMap<WorkspaceId, AssigneeSnapshot>>(new Map());

  const lastSweepTimes = Effect.fn("TriggerObservation.lastSweepTimes")(function* (
    subscription: TriggerSubscription,
  ) {
    const admissions = yield* Effect.all([store.admissions, store.processed]).pipe(
      Effect.map((all) => all.flat()),
    );
    return admissions
      .filter(
        (admission) =>
          admission.event.entry === sweepKey &&
          admission.subscription.workflow === subscription.workflow &&
          admission.subscription.trigger === subscription.trigger,
      )
      .reduce((times, admission) => {
        const item = keyOf(admission.event.key);
        return new Map(times).set(item, Math.max(times.get(item) ?? 0, admission.event.atMillis));
      }, new Map<string, number>());
  });

  const trackerSweepCandidates = Effect.fn("TriggerObservation.trackerSweepCandidates")(function* (
    subscription: TriggerSubscription,
    tickInstant: number,
    state: string,
    sweptAt: ReadonlyMap<string, number>,
  ) {
    const registryState = yield* registry.state;
    const listedWorkflows = yield* workflows.list;
    const document =
      listedWorkflows.workflows.find(({ id }) => id === subscription.workflow)?.publishedCopy ?? null;
    const systems = trackerSystemsOf(document);
    const workspaces = registryState.workspaces.filter(({ config }) => {
      const isSelected = subscription.workspaces.includes(config.name);
      const matchesSystem =
        systems.size === 0 ||
        trackerSystems.some((system) => systems.has(system) && config.issueTracker.type === system);
      return isSelected && matchesSystem;
    });
    const listed = yield* Effect.forEach(workspaces, (workspace) =>
      tracker.observe(workspace).pipe(
        Effect.flatMap((items) =>
          Effect.forEach(items, (item) => {
            const key = { _tag: "Issue", workspace: workspace.config.name, id: item.id } as const;
            return coordination.read(key).pipe(Effect.map((view) => ({ item, key, view, workspace })));
          }),
        ),
      ),
    );
    return listed.flat().flatMap(({ item, key, view, workspace }): ReadonlyArray<SweepCandidate> => {
      const matchesState = state === "parked" ? view.park !== null : (item.states ?? []).includes(state);
      if (!matchesState) return [];
      const lastTouchedAtMillis = Math.max(
        item.lastTouchedAtMillis ?? tickInstant,
        view.park?.atMillis ?? 0,
        sweptAt.get(keyOf(key)) ?? 0,
      );
      return [
        {
          key,
          workspace: workspace.config.name,
          subject: providerSubject(item.title, item.url),
          lastTouchedAtMillis,
          loadWorkContext: tracker.readProse(workspace, item.id).pipe(Effect.mapError(sweepFailure)),
        },
      ];
    });
  });

  const workflowSweepCandidates = Effect.fn("TriggerObservation.workflowSweepCandidates")(function* (
    subscription: TriggerSubscription,
    state: string,
    sweptAt: ReadonlyMap<string, number>,
  ) {
    const admissions = yield* Effect.all([store.admissions, store.processed]).pipe(
      Effect.map((all) => all.flat()),
    );
    const latest = admissions
      .filter(
        (admission) =>
          admission.subscription.workflow === subscription.workflow &&
          admission.event.entry !== sweepKey &&
          admission.event.key._tag !== "Issue",
      )
      .reduce((items, admission) => {
        const item = keyOf(admission.event.key);
        const current = items.get(item);
        return current === undefined || current.event.atMillis < admission.event.atMillis
          ? new Map(items).set(item, admission)
          : items;
      }, new Map<string, TriggerAdmission>());
    return yield* Effect.forEach([...latest.values()], (admission) =>
      coordination.read(admission.event.key).pipe(
        Effect.map((view): SweepCandidate | null => {
          const matchesState = state === "parked" && view.park !== null;
          if (!matchesState) return null;
          return {
            key: admission.event.key,
            workspace: admission.event.workspace,
            subject: admission.event.subject,
            lastTouchedAtMillis: Math.max(
              admission.event.atMillis,
              view.park?.atMillis ?? 0,
              sweptAt.get(keyOf(admission.event.key)) ?? 0,
            ),
            loadWorkContext: Effect.succeed(admission.event.workContext),
          };
        }),
      ),
    ).pipe(Effect.map((candidates) => candidates.filter((candidate) => candidate !== null)));
  });

  const sweep = Effect.fn("TriggerObservation.sweep")(function* (
    subscription: TriggerSubscription,
    tickInstant: number,
  ) {
    const source = subscriptionParameter(subscription, "source");
    const state = subscriptionParameter(subscription, "state");
    if (state === undefined) return yield* sweepFailure("Sweep state is missing");
    const sweptAt = yield* lastSweepTimes(subscription);
    const reader = [
      {
        source: "trackers",
        read: () => trackerSweepCandidates(subscription, tickInstant, state, sweptAt),
      },
      {
        source: "workflow",
        read: () => workflowSweepCandidates(subscription, state, sweptAt),
      },
    ].find((candidate) => candidate.source === source);
    if (reader === undefined) return yield* sweepFailure("Sweep source is invalid");
    return yield* reader.read();
  });
  const sweepReadPort: TriggerReadPort = {
    sweep: (subscription, tickInstant) =>
      sweep(subscription, tickInstant).pipe(Effect.mapError(sweepFailure)),
  };

  const setHealth = (
    source: TriggerSource["id"],
    status: TriggerSourceHealth["status"],
    message: string | null,
  ) => Ref.update(health, (current) => new Map(current).set(source, { source, status, message }));

  const refreshWorkspaceAssignees = Effect.fn("TriggerObservation.refreshWorkspaceAssignees")(function* (
    workspace: Effect.Success<typeof registry.state>["workspaces"][number],
    now: number,
  ) {
    const current = freshAssignees((yield* Ref.get(assigneeSnapshots)).get(workspace.config.name), now);
    if (current) return current;
    const items = yield* tracker.observe(workspace);
    const assignees = new Map(items.map(({ id, assignees }) => [id, assignees] as const));
    yield* Ref.update(assigneeSnapshots, (snapshots) =>
      new Map(snapshots).set(workspace.config.name, { atMillis: now, assignees }),
    );
    return assignees;
  });

  const refreshItemAssignees = Effect.fn("TriggerObservation.refreshItemAssignees")(function* (
    workspace: Effect.Success<typeof registry.state>["workspaces"][number],
    itemId: WorkItemId,
    now: number,
  ) {
    const refreshed = yield* refreshWorkspaceAssignees(workspace, now);
    if (refreshed.has(itemId)) return refreshed.get(itemId) ?? [];
    const assignees = yield* tracker.assignees?.(workspace, itemId) ?? Effect.succeed([]);
    yield* Ref.update(assigneeSnapshots, (snapshots) =>
      new Map(snapshots).set(workspace.config.name, {
        atMillis: now,
        assignees: new Map(refreshed).set(itemId, assignees),
      }),
    );
    return assignees;
  });

  const itemAssignees = Effect.fn("TriggerObservation.itemAssignees")(function* (
    workspace: Effect.Success<typeof registry.state>["workspaces"][number],
    itemId: WorkItemId,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const cached = freshAssignees((yield* Ref.get(assigneeSnapshots)).get(workspace.config.name), now);
    if (cached?.has(itemId)) return cached.get(itemId) ?? [];
    return yield* assigneeGate.withPermit(refreshItemAssignees(workspace, itemId, now));
  });

  const hasAllowlistedAssignee = Effect.fn("TriggerObservation.hasAllowlistedAssignee")(function* (
    workspace: Effect.Success<typeof registry.state>["workspaces"][number],
    allowlist: ReadonlyArray<string>,
    itemId: WorkItemId,
  ) {
    const assignees = yield* itemAssignees(workspace, itemId);
    return assignees.some((assignee) => allowlist.includes(assignee));
  });

  const pullRequestLinkedItems = Effect.fn("TriggerObservation.pullRequestLinkedItems")(function* (
    workspace: Effect.Success<typeof registry.state>["workspaces"][number],
    pullRequest: NonNullable<TriggerEvent["pullRequest"]>,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const observed = yield* assigneeGate.withPermit(refreshWorkspaceAssignees(workspace, now));
    const closing =
      workspace.config.issueTracker.type === "github"
        ? pullRequest.closingIssueNumbers.map((number) => WorkItemId.make(`#${number}`))
        : [];
    return [...new Set([...observed.keys(), ...closing])].filter((id) => pullMatchesLinkKey(id, pullRequest));
  });

  const ownsPullRequest = Effect.fn("TriggerObservation.ownsPullRequest")(function* (
    workspace: Effect.Success<typeof registry.state>["workspaces"][number],
    allowlist: ReadonlyArray<string>,
    pullRequest: TriggerEvent["pullRequest"],
  ) {
    if (pullRequest === undefined) return false;
    const linked = yield* pullRequestLinkedItems(workspace, pullRequest);
    if (linked.length === 0) return allowlist.includes(pullRequest.author);
    const owned = yield* Effect.forEach(linked, (itemId) =>
      hasAllowlistedAssignee(workspace, allowlist, itemId),
    );
    return owned.includes(true);
  });

  const passesAssigneeGate = Effect.fn("TriggerObservation.passesAssigneeGate")(function* (
    event: TriggerEvent,
  ) {
    if (event.workspace === null) return true;
    const state = yield* registry.state;
    const workspace = state.workspaces.find(({ config }) => config.name === event.workspace);
    if (workspace === undefined) return false;
    const allowlist = workspace.config.issueTracker.assigneeAllowlist;
    if (allowlist === undefined) return true;
    return yield* WorkItemRef.match(event.key, {
      Issue: ({ id }) => hasAllowlistedAssignee(workspace, allowlist, id),
      PullRequest: () => ownsPullRequest(workspace, allowlist, event.pullRequest),
      GranolaNote: ungated,
      SlackMessage: ungated,
      SlackConversation: ungated,
      ScheduleInstant: ungated,
      FanOutChild: ungated,
    });
  });

  const publishedSubscriptions = Effect.fn("TriggerObservation.publishedSubscriptions")(function* () {
    const [listed, registryState] = yield* Effect.all([workflows.list, registry.state]);
    return subscriptionsOf(
      listed.workflows,
      registryState.workspaces.map(({ config }) => config.name),
      conditionEntries,
    );
  });

  const admit = Effect.fn("TriggerObservation.admit")(function* (
    source: TriggerSource,
    subscriptions: ReadonlyArray<TriggerSubscription>,
    event: TriggerEvent,
  ) {
    const passesGate = yield* passesAssigneeGate(event).pipe(
      Effect.catchTag("IssueTrackerError", (error) =>
        Effect.logWarning("trigger assignee lookup failed", {
          workspace: event.workspace,
          item: keyOf(event.key),
          message: error.message,
        }).pipe(Effect.map(() => false)),
      ),
    );
    if (!passesGate) return;
    const current = new Set(
      sourceSubscriptions(source, yield* publishedSubscriptions()).map(subscriptionIdentity),
    );
    const active = subscriptions.filter((subscription) => current.has(subscriptionIdentity(subscription)));
    if (active.length === 0) return;
    const outcome = yield* coordination.observe(event.key, event.revision, event.cause);
    const matched = matchTriggerEvent(active, event);
    if (matched.length === 0) return;
    const redeliveryView = outcome === "redelivered" ? yield* coordination.read(event.key) : null;
    const redeliveryIsClosed =
      redeliveryView !== null &&
      (redeliveryView.revision?.observed !== event.revision ||
        redeliveryView.revision.processed === event.revision);
    if (redeliveryIsClosed) return;
    const admissions = matched.map(
      (subscription) => ({ event, subscription, lineage: lineageOf(event) }) satisfies TriggerAdmission,
    );
    const rejection = planRejectionOf(event);
    const isAlreadyParked = samePlanRejection(redeliveryView?.park?.reason, rejection);
    if (rejection !== null && !isAlreadyParked) yield* coordination.park(event.key, rejection);
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
    source.observe(subscriptions, sweepReadPort).pipe(
      Stream.runForEach((event) =>
        decodeTriggerEvent(event).pipe(
          Effect.matchEffect({
            onFailure: (error) =>
              Effect.logWarning("Trigger event does not decode; skipping it", {
                source: source.id,
                item: keyOf(event.key),
                message: error.message,
              }),
            onSuccess: (decoded) => admit(source, subscriptions, decoded),
          }),
        ),
      ),
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
          Effect.all([Clock.currentTimeMillis, registry.state]).pipe(
            Effect.flatMap(([atMillis, registryState]) =>
              store.activate(
                subscriptionsOf(
                  listed.workflows,
                  registryState.workspaces.map(({ config }) => config.name),
                  conditionEntries,
                ),
                atMillis,
              ),
            ),
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

  const recheck = Effect.fn("TriggerObservation.recheck")(function* (admission: TriggerAdmission) {
    const source = sources.find((candidate) => ownsEntry(candidate, admission.event.entry));
    if (!source?.recheck) return Recheck.Matches();
    const published = (yield* publishedSubscriptions()).find((candidate) =>
      startsSamePublishedTrigger(candidate, admission),
    );
    if (published === undefined) return Recheck.Matches();
    return yield* source
      .recheck(admission.event, published)
      .pipe(
        Effect.catchTag("SourceFailure", (error) =>
          Effect.logWarning("Trigger recheck failed; the item counts as matching", { error }).pipe(
            Effect.map(() => Recheck.Matches()),
          ),
        ),
      );
  });

  return {
    eligible: Effect.all([workflows.list, store.admissions]).pipe(
      Effect.flatMap(([listed, current]) => {
        const enabled = new Set(listed.workflows.filter(({ enabled }) => enabled).map(({ id }) => id));
        return Effect.forEach(oldestRevisionAdmissions(current), (admission) =>
          coordination.read(admission.event.key).pipe(
            Effect.flatMap((view) => {
              const canAdvance = view.park !== null && revisionAdvancedParks.has(view.park.reason._tag);
              if (!canAdvance) return Effect.succeed(admission);
              const next = current
                .filter((candidate) => sameSubscription(candidate, admission))
                .filter((candidate) => admissionIsOlder(admission, candidate))
                .toSorted((left, right) => (admissionIsOlder(left, right) ? -1 : 1))
                .at(0);
              if (next === undefined) return Effect.succeed(admission);
              return store.complete(admission, Effect.void).pipe(Effect.map(() => next));
            }),
          ),
        ).pipe(
          Effect.flatMap((oldest) => {
            const active = oldest.filter(({ subscription }) => enabled.has(subscription.workflow));
            const inactive = oldest.filter(({ subscription }) => !enabled.has(subscription.workflow));
            return Effect.forEach(
              inactive,
              (admission) =>
                store.complete(
                  admission,
                  coordination.markProcessed(admission.event.key, admission.event.revision),
                ),
              { discard: true },
            ).pipe(
              Effect.andThen(
                Effect.forEach(active, (admission) =>
                  coordination.read(admission.event.key).pipe(
                    Effect.map((view) => ({
                      admission,
                      actedOn: view.actedOn(admission.subscription.workflow),
                      isUnprocessedRevision: view.revision?.processed !== admission.event.revision,
                      gate: view.gate(
                        {
                          workflow: admission.subscription.workflow,
                          operation: admission.subscription.operation,
                        },
                        admission.event.revision,
                      ),
                    })),
                  ),
                ),
              ),
            );
          }),
        );
      }),
      Effect.map((states) =>
        states
          .filter(({ gate, isUnprocessedRevision }) => isUnprocessedRevision && gate._tag === "Open")
          .toSorted(waitingAdmissionOrder)
          .map(({ admission }) => admission),
      ),
      Effect.catchCause(() => Effect.succeed([])),
    ),
    recheck,
    changes: Stream.fromPubSub(changes),
    health: Effect.map(Ref.get(health), (current) => [...current.values()]),
    catalog: sources.flatMap(({ entries }) => entries),
    refresh: refresh(),
  } satisfies TriggerObservationService;
});

const unavailableObservation: TriggerObservationService = {
  eligible: Effect.succeed([]),
  recheck: () => Effect.succeed(Recheck.Matches()),
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
