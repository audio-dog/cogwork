import {
  keyOf,
  type Lineage,
  LineageId,
  type WorkflowCatalog,
  type WorkflowRecord,
  type WorkItemRef,
} from "@cogwork/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Coordination } from "./coordination";
import type { TriggerEvent, TriggerSource, TriggerSubscription } from "./trigger-source";
import { TriggerSources } from "./trigger-source";
import { Workflows } from "./workflow";

export interface TriggerAdmission {
  readonly event: TriggerEvent;
  readonly subscription: TriggerSubscription;
  readonly lineage: Lineage;
}

export interface TriggerSourceHealth {
  readonly source: TriggerSource["id"];
  readonly status: "idle" | "observing" | "failed";
  readonly message: string | null;
}

export const matchTriggerEvent = (subscriptions: ReadonlyArray<TriggerSubscription>, event: TriggerEvent) =>
  subscriptions.filter((subscription) => {
    const sameScheduleWorkflow =
      event.key._tag !== "ScheduleInstant" || event.key.workflow === subscription.workflow;
    const sameWorkspace = event.workspace === null || subscription.workspaces.includes(event.workspace);
    return subscription.entry === event.entry && sameScheduleWorkflow && sameWorkspace;
  });

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
    subscriptions.map(({ workflow, trigger, entry, parameters, workspaces, catchUp }) => ({
      workflow,
      trigger,
      entry,
      parameters,
      workspaces,
      catchUp,
    })),
  );

const lineageOf = (ref: WorkItemRef): Lineage => ({
  root: Schema.decodeSync(LineageId)(keyOf(ref)),
  parent: null,
  hop: 0,
});

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
  const sources = yield* TriggerSources;
  const fibers = yield* FiberMap.make<TriggerSource["id"]>();
  const fingerprints = yield* Ref.make<ReadonlyMap<TriggerSource["id"], string>>(new Map());
  const admissions = yield* Ref.make<ReadonlyMap<string, TriggerAdmission>>(new Map());
  const health = yield* Ref.make<ReadonlyMap<TriggerSource["id"], TriggerSourceHealth>>(
    new Map(sources.map(({ id }) => [id, { source: id, status: "idle", message: null }])),
  );
  const changes = yield* PubSub.unbounded<TriggerAdmission>();

  const setHealth = (
    source: TriggerSource["id"],
    status: TriggerSourceHealth["status"],
    message: string | null,
  ) => Ref.update(health, (current) => new Map(current).set(source, { source, status, message }));

  const admit = Effect.fn("TriggerObservation.admit")(function* (
    subscriptions: ReadonlyArray<TriggerSubscription>,
    event: TriggerEvent,
  ) {
    const matched = matchTriggerEvent(subscriptions, event);
    yield* Effect.forEach(matched, (subscription) =>
      coordination.observe(event.key, event.revision, event.cause).pipe(
        Effect.flatMap(() => {
          const admission = { event, subscription, lineage: lineageOf(event.key) } satisfies TriggerAdmission;
          const key = `${keyOf(event.key)}:${event.revision}`;
          return Ref.update(admissions, (current) => new Map(current).set(key, admission)).pipe(
            Effect.andThen(PubSub.publish(changes, admission)),
            Effect.asVoid,
          );
        }),
      ),
    );
  });

  const observe = (source: TriggerSource, subscriptions: ReadonlyArray<TriggerSubscription>) =>
    source.observe(subscriptions).pipe(
      Stream.runForEach((event) => admit(subscriptions, event)),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause) ? Effect.void : setHealth(source.id, "failed", Cause.pretty(cause)),
      ),
      Effect.ensuring(
        Ref.update(fingerprints, (current) => {
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
    yield* FiberMap.run(fibers, source.id, observe(source, subscriptions));
  });

  const refresh = () =>
    workflows.list.pipe(
      Effect.flatMap((listed) => {
        const subscriptions = subscriptionsOf(listed.workflows);
        return Effect.forEach(
          sources,
          (source) => syncSource(source, sourceSubscriptions(source, subscriptions)),
          { discard: true },
        );
      }),
      Effect.catchCause((cause) => Effect.logError("trigger subscription refresh failed", { cause })),
    );

  yield* Effect.forkScoped(refresh().pipe(Effect.repeat(Schedule.spaced("5 seconds"))));

  return {
    eligible: Effect.all([workflows.list, Ref.get(admissions)]).pipe(
      Effect.flatMap(([listed, current]) => {
        const enabled = new Set(listed.workflows.filter(({ enabled }) => enabled).map(({ id }) => id));
        return Effect.forEach([...current.values()], (admission) =>
          coordination.read(admission.event.key).pipe(
            Effect.map((view) => ({
              admission,
              enabled: enabled.has(admission.subscription.workflow),
              gate: view.gate({
                workflow: admission.subscription.workflow,
                operation: admission.subscription.trigger,
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
