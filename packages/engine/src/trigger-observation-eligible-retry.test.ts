import { AttemptRecord } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { TestClock } from "effect/testing";

import { Coordination, makeCoordination } from "./coordination";
import { DaemonEventBus, make as makeDaemonEventBus } from "./daemon-event-bus";
import { IssueTracker, makeEmpty as makeEmptyIssueTracker } from "./issue-tracker";
import { emptyRegistry } from "./projector";
import { readOnlyRegistry, WorkspaceRegistry } from "./registry-service";
import { make } from "./trigger-observation";
import type { TriggerAdmission } from "./trigger-observation-admission";
import { event, lineage, record, subscription, workflowService } from "./trigger-observation-fixtures";
import { makeMemoryTriggerObservationStore, TriggerObservationStore } from "./trigger-observation-store";
import { TriggerSources } from "./trigger-source";
import { Workflows } from "./workflow";

describe("TriggerObservation", () => {
  it.effect("offers a failed admission again only after the retry delay", () =>
    Effect.gen(function* () {
      const store = yield* makeMemoryTriggerObservationStore;
      yield* store.putAll([{ event, subscription, lineage }]);
      const failedAttempt = AttemptRecord.make({
        operation: { workflow: subscription.workflow, operation: subscription.operation },
        outcome: "failed",
        atMillis: 1,
        lineage,
      });
      const unused = () => Effect.die("unused");
      const authority = {
        read: () =>
          Effect.succeed({
            claim: null,
            attempts: [failedAttempt],
            handbacks: [],
            parks: [],
            revision: { observed: event.revision, processed: "earlier-revision" },
          }),
        claim: unused,
        release: unused,
        recordAttempt: unused,
        park: unused,
        handBack: unused,
        observe: unused,
        markProcessed: unused,
      };
      const observation = yield* make.pipe(
        Effect.provideService(Workflows, workflowService(yield* Ref.make(record(true)))),
        Effect.provideService(Coordination, makeCoordination(authority, authority)),
        Effect.provideService(TriggerSources, []),
        Effect.provideService(TriggerObservationStore, store),
        Effect.provideService(DaemonEventBus, yield* makeDaemonEventBus),
        Effect.provideService(IssueTracker, yield* makeEmptyIssueTracker),
        Effect.provideService(WorkspaceRegistry, readOnlyRegistry(emptyRegistry)),
      );
      const revisionsOf = (admissions: ReadonlyArray<TriggerAdmission>) =>
        admissions.map(({ event: candidate }) => candidate.revision);

      yield* TestClock.setTime(failedAttempt.atMillis);
      assert.deepStrictEqual(revisionsOf(yield* observation.eligible), []);
      yield* TestClock.adjust("1 minute");
      assert.deepStrictEqual(revisionsOf(yield* observation.eligible), [event.revision]);
    }).pipe(Effect.scoped),
  );
});
