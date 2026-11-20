import {
  type ControlStoreFailure,
  DaemonEvent,
  keyOf,
  type Lineage,
  LineageId,
  type ParkReason,
  type QueuedItem,
  type SchedulerQueue,
  type TriggerSourceHealth,
  type WorkflowCatalog,
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
import { Coordination, type CoordinationError, type CoordinationGate } from "./coordination";
import { DaemonEventBus } from "./daemon-event-bus";
import { WorkspaceRegistry } from "./registry-service";
import {
  admissionIsOlder,
  oldestRevisionAdmissions,
  revisionAdvancedParks,
  runWorkItemOf,
  runWorkspaceOf,
  sameSubscription,
  type TriggerAdmission,
  waitingAdmissionOrder,
} from "./trigger-observation-admission";
import { makeAssigneeGate } from "./trigger-observation-assignees";
import { TriggerObservationStore, type TriggerObservationStoreError } from "./trigger-observation-store";
import {
  addressedSubscriptions,
  fingerprintOf,
  matchTriggerEvent,
  passesTriggerFilters,
  sourceSubscriptions,
  startsSamePublishedTrigger,
  subscriptionIdentity,
  subscriptionsOf,
} from "./trigger-observation-subscriptions";
import { makeSweepReadPort } from "./trigger-observation-sweep";
import {
  ownsEntry,
  Recheck,
  type SourceFailure,
  TriggerEvent,
  type TriggerSource,
  TriggerSources,
  type TriggerSubscription,
} from "./trigger-source";
import { Workflows } from "./workflow";

const decodeTriggerEvent = Schema.decodeUnknownEffect(TriggerEvent);

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

const admissionsOf = (subscriptions: ReadonlyArray<TriggerSubscription>, event: TriggerEvent) =>
  subscriptions.map(
    (subscription) => ({ event, subscription, lineage: lineageOf(event) }) satisfies TriggerAdmission,
  );

interface AdmissionState {
  readonly admission: TriggerAdmission;
  readonly gate: CoordinationGate;
  readonly isUnprocessedRevision: boolean;
}

const isOfferable = ({ admission, gate, isUnprocessedRevision }: AdmissionState) => {
  const passesFilters = passesTriggerFilters(admission.subscription, admission.event);
  return isUnprocessedRevision && gate._tag === "Open" && passesFilters;
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

const queuedItemOf = (admission: TriggerAdmission, index: number) =>
  ({
    place: index + 1,
    workspace: runWorkspaceOf(admission),
    workItem: runWorkItemOf(admission),
    ...(admission.event.subject ? { subject: admission.event.subject } : {}),
    workflow: admission.subscription.workflow,
    operation: admission.subscription.operation,
  }) satisfies QueuedItem;

const waitForRetry = (failure: SourceFailure) => {
  const retryRules = [
    { matches: failure.reason === "connection-not-ready", wait: Effect.never },
    { matches: failure.retryAfterMillis === null, wait: Effect.void },
  ];
  return retryRules.find(({ matches }) => matches)?.wait ?? Effect.sleep(failure.retryAfterMillis ?? 0);
};

export interface TriggerObservationService {
  readonly eligible: Effect.Effect<ReadonlyArray<TriggerAdmission>>;
  readonly queue: Effect.Effect<
    SchedulerQueue,
    ControlStoreFailure | TriggerObservationStoreError | CoordinationError
  >;
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
  const registry = yield* WorkspaceRegistry;
  const fibers = yield* FiberMap.make<TriggerSource["id"]>();
  const fingerprints = yield* Ref.make<ReadonlyMap<TriggerSource["id"], string>>(new Map());
  const health = yield* Ref.make<ReadonlyMap<TriggerSource["id"], TriggerSourceHealth>>(
    new Map(sources.map(({ id }) => [id, { source: id, status: "idle", message: null }])),
  );
  const changes = yield* PubSub.unbounded<TriggerAdmission>();
  const refreshGate = Semaphore.makeUnsafe(1);

  const sweepReadPort = yield* makeSweepReadPort;
  const passesAssigneeGate = yield* makeAssigneeGate;

  const setHealth = (
    source: TriggerSource["id"],
    status: TriggerSourceHealth["status"],
    message: string | null,
  ) => Ref.update(health, (current) => new Map(current).set(source, { source, status, message }));

  const publishedSubscriptions = Effect.fn("TriggerObservation.publishedSubscriptions")(function* () {
    const [listed, registryState] = yield* Effect.all([workflows.list, registry.state]);
    return subscriptionsOf(
      listed.workflows,
      registryState.workspaces.map(({ config }) => config.id),
      conditionEntries,
    );
  });

  const conditionsAddressedBy = (subscriptions: ReadonlyArray<TriggerSubscription>, event: TriggerEvent) =>
    addressedSubscriptions(subscriptions, event).filter(({ entry }) => conditionEntries.has(entry));

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
    const redelivered = outcome === "redelivered";
    if (redelivered) yield* store.refreshPending(admissionsOf(conditionsAddressedBy(active, event), event));
    const matched = matchTriggerEvent(active, event);
    if (matched.length === 0) return;
    const redeliveryView = redelivered ? yield* coordination.read(event.key) : null;
    const redeliveryIsClosed =
      redeliveryView !== null &&
      (redeliveryView.revision?.observed !== event.revision ||
        redeliveryView.revision.processed === event.revision);
    if (redeliveryIsClosed) return;
    const admissions = admissionsOf(matched, event);
    const rejection = planRejectionOf(event);
    const isAlreadyParked = samePlanRejection(redeliveryView?.park?.reason, rejection);
    if (rejection !== null && !isAlreadyParked) yield* coordination.park(event.key, rejection);
    yield* store.putAll(admissions);
    yield* source.acknowledge?.(event, matched) ?? Effect.void;
    if (redelivered) return;
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
                  registryState.workspaces.map(({ config }) => config.id),
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

  const advancedPast = (current: ReadonlyArray<TriggerAdmission>, admission: TriggerAdmission) =>
    coordination.read(admission.event.key).pipe(
      Effect.map((view) => {
        const canAdvance = view.park !== null && revisionAdvancedParks.has(view.park.reason._tag);
        const next = canAdvance
          ? current
              .filter((candidate) => sameSubscription(candidate, admission))
              .filter((candidate) => admissionIsOlder(admission, candidate))
              .toSorted((left, right) => (admissionIsOlder(left, right) ? -1 : 1))
              .at(0)
          : undefined;
        if (next === undefined) return { admission, superseded: [] };
        return { admission: next, superseded: [admission] };
      }),
    );

  const candidates = Effect.fn("TriggerObservation.candidates")(function* () {
    const [listed, current] = yield* Effect.all([workflows.list, store.admissions]);
    const enabled = new Set(listed.workflows.filter(({ enabled }) => enabled).map(({ id }) => id));
    const advanced = yield* Effect.forEach(oldestRevisionAdmissions(current), (admission) =>
      advancedPast(current, admission),
    );
    const oldest = advanced.map(({ admission }) => admission);
    return {
      superseded: advanced.flatMap(({ superseded }) => superseded),
      active: oldest.filter(({ subscription }) => enabled.has(subscription.workflow)),
      inactive: oldest.filter(({ subscription }) => !enabled.has(subscription.workflow)),
    };
  });

  const offerable = (active: ReadonlyArray<TriggerAdmission>) =>
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
    ).pipe(
      Effect.map((states) =>
        states
          .filter(isOfferable)
          .toSorted(waitingAdmissionOrder)
          .map(({ admission }) => admission),
      ),
    );

  const settleStale = ({ superseded, inactive }: Effect.Success<ReturnType<typeof candidates>>) =>
    Effect.forEach(superseded, (admission) => store.complete(admission, Effect.void), {
      discard: true,
    }).pipe(
      Effect.andThen(
        Effect.forEach(
          inactive,
          (admission) =>
            store.complete(
              admission,
              coordination.markProcessed(admission.event.key, admission.event.revision),
            ),
          { discard: true },
        ),
      ),
    );

  return {
    eligible: candidates().pipe(
      Effect.tap(settleStale),
      Effect.flatMap(({ active }) => offerable(active)),
      Effect.catchCause(() => Effect.succeed([])),
    ),
    queue: candidates().pipe(
      Effect.flatMap(({ active }) => offerable(active)),
      Effect.map((queued) => ({ queued: queued.map(queuedItemOf) })),
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
  queue: Effect.succeed({ queued: [] }),
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
