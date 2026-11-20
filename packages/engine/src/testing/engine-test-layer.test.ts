import { HarnessName, RunId, type RunRecord, WorkItemId, WorkspaceId } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as DaemonEventBus from "../daemon-event-bus";
import * as RunLedger from "../run-ledger";
import { RunRecorder } from "../run-recorder";
import { SessionStore } from "../session-store";
import { engineTestLayer } from "./engine-test-layer";

const runId = Schema.decodeSync(RunId)("run-1");
const workspace = Schema.decodeSync(WorkspaceId)("example");
const workItem = Schema.decodeSync(WorkItemId)("#315");
const harness = Schema.decodeSync(HarnessName)("cursor");

const run: RunRecord = {
  id: runId,
  workspace,
  workItem,
  operation: "implement",
  harness,
  branch: null,
  session: null,
  usage: null,
  status: "running",
  startedAtMillis: 1,
  endedAtMillis: null,
};

describe("engineTestLayer", () => {
  it.layer(engineTestLayer())((it) => {
    it.effect("shares one bus, ledger, recorder, and session graph", () =>
      Effect.gen(function* () {
        const bus = yield* DaemonEventBus.DaemonEventBus;
        const ledger = yield* RunLedger.RunLedger;
        const recorder = yield* RunRecorder;
        const sessions = yield* SessionStore;
        const subscription = yield* bus.subscribe();

        yield* ledger.insertRun(run);
        yield* recorder.record(run, { type: "RUN_STARTED" });
        const activity = yield* DaemonEventBus.runActivityStream(Stream.fromSubscription(subscription)).pipe(
          Stream.runHead,
        );
        const session = yield* sessions.mint(
          { workspace, harness, createdAtMillis: 1 },
          () => "opaque-handle",
        );

        assert.strictEqual((yield* ledger.events(runId).pipe(Stream.runCollect)).length, 1);
        assert.isTrue(Option.isSome(activity));
        if (Option.isNone(activity)) return;
        assert.strictEqual(activity.value.runId, runId);
        assert.strictEqual((yield* ledger.getSession(session))?.id, session);
      }),
    );
  });
});
