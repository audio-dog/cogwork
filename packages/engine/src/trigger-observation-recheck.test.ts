import { WorkflowCatalogKey, WorkflowDocument, WorkflowNodeId } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { clockEntries } from "./clock-source";
import { Coordination } from "./coordination";
import { DaemonEventBus, make as makeDaemonEventBus } from "./daemon-event-bus";
import { IssueTracker, makeEmpty as makeEmptyIssueTracker } from "./issue-tracker";
import { emptyRegistry } from "./projector";
import { readOnlyRegistry, WorkspaceRegistry } from "./registry-service";
import { make } from "./trigger-observation";
import type { TriggerAdmission } from "./trigger-observation-admission";
import {
  coordinationService,
  document,
  event,
  lineage,
  record,
  subscription,
  workflowService,
} from "./trigger-observation-fixtures";
import { makeMemoryTriggerObservationStore, TriggerObservationStore } from "./trigger-observation-store";
import { Recheck, SourceFailure, type TriggerSource, TriggerSources } from "./trigger-source";
import { Workflows } from "./workflow";

describe("TriggerObservation recheck", () => {
  const notBlocked = Schema.decodeSync(WorkflowCatalogKey)("schedule.not-blocked");
  const nextOperation = Schema.decodeSync(WorkflowNodeId)("next");
  const hourlyEntry = Schema.decodeSync(WorkflowCatalogKey)("schedule.hourly");
  const filtered = Schema.decodeSync(WorkflowDocument)({
    ...document,
    triggers: document.triggers.map((trigger) => ({ ...trigger, filters: [{ entry: notBlocked }] })),
  });
  const changedEntry = Schema.decodeSync(WorkflowDocument)({
    ...filtered,
    triggers: filtered.triggers.map((trigger) => ({ ...trigger, entry: hourlyEntry })),
  });
  const storedBeforeTheFilter: TriggerAdmission = { event, subscription, lineage };

  const byFilter: NonNullable<TriggerSource["recheck"]> = (_event, { filters }) =>
    Effect.succeed(
      filters.includes(notBlocked) ? Recheck.Waiting({ reason: "fails Not blocked" }) : Recheck.Matches(),
    );

  const recheckWith = Effect.fn("TriggerObservationTest.recheckWith")(function* (
    published: WorkflowDocument,
    admission: TriggerAdmission,
    sourceRecheck = byFilter,
  ) {
    const source: TriggerSource = {
      id: "clock",
      entries: clockEntries,
      availability: () => Effect.succeed({ _tag: "Available" }),
      observe: () => Stream.empty,
      recheck: sourceRecheck,
    };
    const observation = yield* make.pipe(
      Effect.provideService(Workflows, workflowService(yield* Ref.make(record(true, published)))),
      Effect.provideService(
        Coordination,
        coordinationService(
          yield* Ref.make<string | null>(null),
          yield* Ref.make(0),
          yield* Ref.make<string | null>(null),
        ),
      ),
      Effect.provideService(TriggerSources, [source]),
      Effect.provideService(TriggerObservationStore, yield* makeMemoryTriggerObservationStore),
      Effect.provideService(DaemonEventBus, yield* makeDaemonEventBus),
      Effect.provideService(IssueTracker, yield* makeEmptyIssueTracker),
      Effect.provideService(WorkspaceRegistry, readOnlyRegistry(emptyRegistry)),
    );
    return yield* observation.recheck(admission);
  });

  it.effect(
    "checks an admission against the published Trigger, not the subscription it was stored with",
    () =>
      Effect.gen(function* () {
        assert.deepStrictEqual(storedBeforeTheFilter.subscription.filters, []);
        assert.deepStrictEqual(
          yield* recheckWith(filtered, storedBeforeTheFilter),
          Recheck.Waiting({ reason: "fails Not blocked" }),
        );
      }).pipe(Effect.scoped),
  );

  it.effect("does not check an admission handed off past the Trigger's start Operation", () =>
    Effect.gen(function* () {
      const handedOff: TriggerAdmission = {
        ...storedBeforeTheFilter,
        subscription: { ...subscription, operation: nextOperation },
      };

      assert.deepStrictEqual(yield* recheckWith(filtered, handedOff), Recheck.Matches());
    }).pipe(Effect.scoped),
  );

  it.effect("does not check an admission whose Trigger now names another entry", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* recheckWith(changedEntry, storedBeforeTheFilter), Recheck.Matches());
    }).pipe(Effect.scoped),
  );

  it.effect("counts an item as matching when the source cannot read it", () =>
    Effect.gen(function* () {
      const unreadable = () =>
        Effect.fail(
          new SourceFailure({
            source: "clock",
            reason: "unavailable",
            retryAfterMillis: null,
            message: "down",
          }),
        );

      assert.deepStrictEqual(
        yield* recheckWith(filtered, storedBeforeTheFilter, unreadable),
        Recheck.Matches(),
      );
    }).pipe(Effect.scoped),
  );
});
