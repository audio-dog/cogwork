import { connectionIdOf, DaemonRpcs, RunId, WorkItemId, WorkspaceId } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as RpcClient from "effect/rpc/RpcClient";
import * as TestClock from "effect/testing/TestClock";
import { Coordination } from "./coordination";
import {
  claimCrashedIssue,
  crashedIssue,
  Fixture,
  githubSourceControl,
  githubType,
  harnessName,
  issueRun,
  reconcileWorktrees,
  startHeartbeats,
  testLayer,
} from "./daemon-composition-fixtures";
import * as RunLedger from "./run-ledger";
import { Scheduler } from "./scheduler";
import { TriggerObservation } from "./trigger-observation";

describe("daemon composition", () => {
  it.effect("creates, publishes, and enables the coding template before triaging through the daemon", () =>
    Effect.gen(function* () {
      const fixture = yield* Fixture;
      const rpc = yield* RpcClient.make(DaemonRpcs);
      assert.deepStrictEqual((yield* rpc.ListWorkflows()).workflows, []);
      yield* rpc.EstablishConnection({
        establishment: { system: "github", source: { _tag: "Stored" } },
      });
      const registration = yield* rpc.RegisterWorkspace({
        registration: {
          name: WorkspaceId.make("github"),
          checkoutPath: fixture.checkoutPath,
          issueTracker: { type: githubType, connectionId: connectionIdOf("github", "owner") },
          linearHistory: false,
        },
      });
      assert.strictEqual(registration._tag, "Registered");
      if (registration._tag !== "Registered") return;
      yield* rpc.SetOperationSetting({
        updates: [
          {
            _tag: "Set",
            row: {
              setting: "harness",
              level: { _tag: "Default" },
              scope: { _tag: "SettingsProfile" },
              value: harnessName,
            },
          },
        ],
      });
      const templates = yield* rpc.GetWorkflowTemplates();
      assert.includeMembers(
        templates.map(({ id }) => id),
        ["github-coding-pipeline", "linear-coding-pipeline"],
      );
      const template = templates.find(({ id }) => id === "github-coding-pipeline");
      if (!template) return assert.fail("GitHub coding template is missing");
      const created = yield* rpc.CreateWorkflow({ document: template.document });
      const published = yield* rpc.PublishWorkflow({ id: created.id, revision: created.workingRevision });
      yield* rpc.SwitchWorkflow({ id: published.id, enabled: true });
      yield* TestClock.adjust("1 minute");
      const eligible = yield* (yield* TriggerObservation).eligible;
      assert.deepStrictEqual(
        eligible.map(({ event }) => event.key),
        [{ _tag: "Issue", workspace: registration.name, id: WorkItemId.make("#1") }],
      );
      yield* rpc.SetScheduling({ desired: "running" });
      const scheduler = yield* Scheduler;
      assert.strictEqual(yield* scheduler.tick(), 1);
      yield* scheduler.awaitIdle;

      const labelWrite = fixture.fetchStub.mock.calls.some(([input, init]) => {
        const request = new Request(input, init);
        return request.method === "POST" && request.url.endsWith("/issues/1/labels");
      });
      assert.isTrue(labelWrite);
    }).pipe(Effect.provide(testLayer()), Effect.scoped),
  );

  it.effect("marks a Run the stopped daemon left running as crashed and releases its Claim", () =>
    Effect.gen(function* () {
      const ledger = yield* RunLedger.RunLedger;
      const coordination = yield* Coordination;
      yield* claimCrashedIssue();
      yield* ledger.insertRun(issueRun("left-running", "running", 1));

      yield* startHeartbeats();

      assert.strictEqual((yield* ledger.getRun(RunId.make("left-running")))?.status, "crashed");
      const view = yield* coordination.read(crashedIssue);
      assert.isNull(view.claim);
      assert.isNull(view.park);
    }).pipe(Effect.provide(testLayer()), Effect.scoped),
  );

  it.effect("parks an item exhausted after its third Run in a row dies with the daemon", () =>
    Effect.gen(function* () {
      const ledger = yield* RunLedger.RunLedger;
      yield* claimCrashedIssue();
      yield* ledger.insertRun(issueRun("first-crash", "crashed", 1));
      yield* ledger.insertRun(issueRun("second-crash", "crashed", 2));
      yield* ledger.insertRun(issueRun("left-running", "running", 3));

      yield* startHeartbeats();

      const view = yield* (yield* Coordination).read(crashedIssue);
      assert.strictEqual(view.park?.reason._tag, "Exhausted");
    }).pipe(Effect.provide(testLayer()), Effect.scoped),
  );

  it.effect("maintains worktrees and reads pull requests once per poll interval", () =>
    Effect.gen(function* () {
      const fixture = yield* Fixture;
      const rpc = yield* RpcClient.make(DaemonRpcs);
      reconcileWorktrees.mockClear();
      yield* rpc.EstablishConnection({ establishment: { system: "github", source: { _tag: "Stored" } } });
      const connectionId = connectionIdOf("github", "owner");
      const registration = yield* rpc.RegisterWorkspace({
        registration: {
          name: WorkspaceId.make("github"),
          checkoutPath: fixture.checkoutPath,
          issueTracker: { type: githubType, connectionId },
          sourceControl: { type: githubSourceControl, connectionId },
          worktrees: { reapAfterMillis: 1 },
          linearHistory: false,
        },
      });
      if (registration._tag !== "Registered") return assert.fail("Workspace registration failed");
      const pullListReads = () =>
        fixture.fetchStub.mock.calls.filter(([input, init]) => {
          const request = new Request(input, init);
          return request.method === "GET" && new URL(request.url).pathname.endsWith("/pulls");
        }).length;
      const readsBeforeHeartbeats = pullListReads();

      yield* startHeartbeats();
      yield* TestClock.adjust("50 seconds");

      assert.deepStrictEqual(
        reconcileWorktrees.mock.calls.map(([workspace]) => workspace.config.name),
        [registration.name],
      );
      const heartbeatReads = pullListReads() - readsBeforeHeartbeats;
      assert.isAbove(heartbeatReads, 0);
      assert.isAtMost(heartbeatReads, 2);
    }).pipe(Effect.provide(testLayer()), Effect.scoped),
  );
});
