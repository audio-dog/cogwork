import {
  type HarnessEnablement,
  type HarnessName,
  HarnessReadiness,
  HarnessReadinessItem,
  HarnessState,
  harnessEnabled,
} from "@cogwork/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import { ControlStore } from "./control-store";
import { DaemonEventBus } from "./daemon-event-bus";
import {
  Harness,
  type HarnessError,
  type HarnessReadiness as HarnessProbeReadiness,
  type HarnessService,
} from "./harness";
import { harnessStateOf } from "./harness-overview";

const probeDeadline = "10 seconds";
const notCheckedDiagnostic = "Harness readiness has not been checked yet";
const readableDiagnostic = (message: string) => message.trim() || "the harness gave no reason";
const readableDiagnostics = (messages: ReadonlyArray<string>) => [
  ...new Set(messages.map((message) => message.trim()).filter(Boolean)),
];

interface CacheState {
  readonly items: ReadonlyMap<HarnessName, HarnessReadinessItem>;
  readonly checkedAtMillis: number;
}

interface PendingRefresh {
  readonly all: boolean;
  readonly failures: ReadonlyMap<HarnessName, HarnessError>;
}

interface ItemObservation {
  readonly version: string | null;
  readonly state: HarnessState;
  readonly diagnostics: ReadonlyArray<string>;
}

const emptyPendingRefresh = (): PendingRefresh => ({ all: false, failures: new Map() });

const observedItem = (name: HarnessName, observation: ItemObservation) =>
  HarnessReadinessItem.make({
    harness: name,
    enabled: true,
    ...observation,
    diagnostics: readableDiagnostics(observation.diagnostics),
  });

const unknownItem = (name: HarnessName) =>
  observedItem(name, {
    version: null,
    state: HarnessState.cases.Unknown.make({ diagnostic: notCheckedDiagnostic }),
    diagnostics: [],
  });

const unreachableItem = (name: HarnessName, message: string) => {
  const diagnostic = readableDiagnostic(message);
  return observedItem(name, {
    version: null,
    state: HarnessState.cases.Unknown.make({ diagnostic }),
    diagnostics: [diagnostic],
  });
};

const readinessAfterFailure = (readiness: HarnessProbeReadiness, failure: HarnessError | null) => {
  if (!failure) return readiness;
  const authentication =
    failure.reason === "credential"
      ? { ...readiness.authentication, status: "unavailable" as const, diagnostic: failure.message }
      : readiness.authentication;
  return {
    ...readiness,
    authentication,
    operational: {
      status: "unavailable" as const,
      retryable: failure.retryable,
      diagnostic: failure.message,
    },
    diagnostics: [...readiness.diagnostics, failure.message],
  };
};

const itemFromReadiness = (harness: HarnessService, name: HarnessName, readiness: HarnessProbeReadiness) =>
  observedItem(name, {
    version: readiness.installation.version,
    state: harnessStateOf(readiness, harness.signIn(name)),
    diagnostics: readiness.diagnostics,
  });

const enabledItem = (settings: ReadonlyArray<HarnessEnablement>, item: HarnessReadinessItem) =>
  HarnessReadinessItem.make({ ...item, enabled: harnessEnabled(settings, item.harness) });

export const make = Effect.gen(function* () {
  const harness = yield* Harness;
  const store = yield* ControlStore;
  const bus = yield* DaemonEventBus;
  const cache = yield* Ref.make<CacheState>({ items: new Map(), checkedAtMillis: 0 });
  const pending = yield* Ref.make<PendingRefresh>(emptyPendingRefresh());
  const signals = yield* Queue.sliding<void>(1);

  const readiness = Effect.fn("HarnessReadinessCache.readiness")(function* (
    settings: ReadonlyArray<HarnessEnablement>,
  ) {
    const cached = yield* Ref.get(cache);
    const harnesses = [...harness.catalogs.keys()].map((name) => {
      const observed = cached.items.get(name) ?? unknownItem(name);
      return enabledItem(settings, observed);
    });
    return HarnessReadiness.make({ harnesses, checkedAtMillis: cached.checkedAtMillis });
  });

  const probe = Effect.fn("HarnessReadinessCache.probe")(function* (
    name: HarnessName,
    failure: HarnessError | null,
  ) {
    return yield* harness.readiness(name).pipe(
      Effect.timeout(probeDeadline),
      Effect.map((readiness) => readinessAfterFailure(readiness, failure)),
      Effect.map((readiness) => itemFromReadiness(harness, name, readiness)),
      Effect.catchTags({
        TimeoutError: () => Effect.succeed(unreachableItem(name, `the probe overran ${probeDeadline}`)),
        HarnessError: (error: HarnessError) => Effect.succeed(unreachableItem(name, error.message)),
      }),
    );
  });

  const refresh = Effect.fn("HarnessReadinessCache.refresh")(function* (request: PendingRefresh) {
    const failedEntries = [...request.failures].flatMap(([name, failure]) =>
      harness.catalogs.has(name) ? [{ name, failure }] : [],
    );
    const entries = request.all
      ? [...harness.catalogs.keys()].map((name) => ({ name, failure: null }))
      : failedEntries;
    if (entries.length === 0) return;
    const refreshed = yield* Effect.forEach(entries, ({ name, failure }) => probe(name, failure), {
      concurrency: "unbounded",
    });
    const refreshedAtMillis = request.all
      ? yield* Clock.currentTimeMillis
      : (yield* Ref.get(cache)).checkedAtMillis;
    yield* Ref.update(cache, (current) => ({
      items: new Map([...current.items, ...refreshed.map((item) => [item.harness, item] as const)]),
      checkedAtMillis: refreshedAtMillis,
    }));
    const settings = yield* store.health === "available"
      ? store.picture.pipe(
          Effect.map((picture) => picture.harnessSettings),
          Effect.catch((error) =>
            Effect.logError("Harness readiness could not read Control store settings", { error }).pipe(
              Effect.map(() => store.seed.harnessSettings),
            ),
          ),
        )
      : Effect.succeed<ReadonlyArray<HarnessEnablement>>([]);
    yield* bus.publish({ _tag: "HarnessesChanged", readiness: yield* readiness(settings) });
  });

  yield* Queue.take(signals).pipe(
    Effect.flatMap(() => Ref.getAndSet(pending, emptyPendingRefresh())),
    Effect.flatMap((request) =>
      refresh(request).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) => Effect.logError("Harness readiness refresh failed", { cause }),
        ),
      ),
    ),
    Effect.forever,
    Effect.forkScoped({ startImmediately: true }),
  );

  const requestAll = Effect.fn("HarnessReadinessCache.requestAll")(function* () {
    yield* Ref.update(pending, (current) => ({ ...current, all: true }));
    yield* Queue.offer(signals, undefined);
  });

  const requestOne = Effect.fn("HarnessReadinessCache.requestOne")(function* (
    name: HarnessName,
    failure: HarnessError,
  ) {
    yield* Ref.update(pending, (current) => ({
      ...current,
      failures: new Map(current.failures).set(name, failure),
    }));
    yield* Queue.offer(signals, undefined);
  });

  yield* requestAll();

  return { readiness, requestAll, requestOne } as const;
});

export type HarnessReadinessCacheService = Effect.Success<typeof make>;

export class HarnessReadinessCache extends Context.Service<
  HarnessReadinessCache,
  HarnessReadinessCacheService
>()("@cogwork/engine/harness-readiness/HarnessReadinessCache") {}

export const layer = Layer.effect(HarnessReadinessCache, make);
