import {
  DaemonEvent,
  keyOf,
  Lineage,
  LineageId,
  type WorkflowCatalog,
  type WorkflowRecord,
  type WorkItemId,
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
import { matchesScheduledInstant } from "./clock-source";
import { ControlStore } from "./control-store";
import { Coordination } from "./coordination";
import { DaemonEventBus } from "./daemon-event-bus";
import { IssueTracker } from "./issue-tracker";
import { WorkspaceRegistry } from "./registry";
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

interface AssigneeSnapshot {
  readonly atMillis: number;
  readonly assignees: ReadonlyMap<WorkItemId, ReadonlyArray<string>>;
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
const checkpointOf = (admission: TriggerAdmission) =>
  admission.event.key._tag === "ScheduleInstant"
    ? admission.event.key.instantMillis
    : admission.event.atMillis;
const assigneeSnapshotTtl = 60_000;
const freshAssignees = (snapshot: AssigneeSnapshot | undefined, now: number) =>
  snapshot && now - snapshot.atMillis < assigneeSnapshotTtl ? snapshot.assignees : null;

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
      Ref.update(admissions, (current) =>
        new Map(current).set(
          `${keyOf(admission.event.key)}:${admission.event.revision}:${subscriptionKey(admission.subscription)}`,
          admission,
        ),
      ).pipe(
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
              INSERT INTO trigger_admissions (work_item, revision, payload)
              VALUES (${keyOf(admission.event.key)}, ${admission.event.revision}, ${encodeAdmission(admission)})
              ON CONFLICT (work_item, revision) DO UPDATE SET payload = excluded.payload
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
  const observed = new Map((event.parameters ?? []).map(({ id, value }) => [id, value]));
  const matched = subscriptions.filter((subscription) => {
    const sameScheduleWorkflow =
      event.key._tag !== "ScheduleInstant" || event.key.workflow === subscription.workflow;
    const sameWorkspace = event.workspace === null || subscription.workspaces.includes(event.workspace);
    const sameSchedule =
      event.key._tag !== "ScheduleInstant" || matchesScheduledInstant(subscription, event.key.instantMillis);
    const sameParameters = [...observed].every(([id, value]) =>
      subscription.parameters.some((parameter) => parameter.id === id && parameter.value === value),
    );
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

const subscriptionsOf = (
  records: ReadonlyArray<WorkflowRecord>,
  everyWorkspace: ReadonlyArray<TriggerSubscription["workspaces"][number]>,
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

const lineageOf = (event: TriggerEvent): Lineage => {
  const current = Schema.decodeSync(LineageId)(keyOf(event.key));
  if (event.cause._tag !== "Cogwork") return { root: current, parent: null, hop: 0 };
  const origin = Schema.decodeSync(LineageId)(event.cause.origin);
  return { root: origin, parent: origin, hop: 1 };
};

const waitForRetry = (retryAtMillis: number | null) =>
  retryAtMillis === null
    ? Effect.void
    : Clock.currentTimeMillis.pipe(Effect.flatMap((now) => Effect.sleep(Math.max(0, retryAtMillis - now))));

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

  const passesAssigneeGate = Effect.fn("TriggerObservation.passesAssigneeGate")(function* (
    event: TriggerEvent,
  ) {
    if (event.workspace === null) return true;
    const state = yield* registry.state;
    const workspace = state.workspaces.find(({ config }) => config.name === event.workspace);
    if (workspace === undefined) return false;
    const allowlist = workspace.config.issueTracker.assigneeAllowlist;
    if (allowlist === undefined) return true;
    if (event.key._tag !== "Issue") return true;
    const assignees = yield* itemAssignees(workspace, event.key.id);
    return assignees.some((assignee) => allowlist.includes(assignee));
  });

  const admit = Effect.fn("TriggerObservation.admit")(function* (event: TriggerEvent) {
    if (!(yield* passesAssigneeGate(event))) return;
    const [listed, registryState] = yield* Effect.all([workflows.list, registry.state]);
    const workspaceIds = registryState.workspaces.map(({ config }) => config.name);
    const matched = matchTriggerEvent(subscriptionsOf(listed.workflows, workspaceIds), event);
    if (matched.length === 0) return;
    const delivery = yield* coordination.observe(event.key, event.revision, event.cause);
    if (delivery === "redelivered") return;
    yield* Effect.forEach(matched, (subscription) => {
      const admission = { event, subscription, lineage: lineageOf(event) } satisfies TriggerAdmission;
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
      Effect.catchTags({
        SourceFailure: (error: SourceFailure) =>
          setHealth(source.id, "failed", error.message).pipe(
            Effect.andThen(waitForRetry(error.retryAfterMillis)),
          ),
        IssueTrackerError: (error) =>
          setHealth(source.id, "failed", error.message).pipe(
            Effect.andThen(waitForRetry(error.retryAfterMillis ?? null)),
          ),
      }),
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
  yield* Effect.forkScoped(
    Effect.all(
      [
        refresh().pipe(Effect.repeat(Schedule.spaced("5 seconds"))),
        bus.events.pipe(Stream.filter(workflowChanged), Stream.runForEach(refresh)),
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
