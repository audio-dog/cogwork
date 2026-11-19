import { connectionIdOf, DaemonRpcs, WorkItemId } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as RpcClient from "effect/rpc/RpcClient";
import * as TestClock from "effect/testing/TestClock";
import { Fixture, githubType, harnessName, testLayer } from "./daemon-composition-fixtures";
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
          displayName: "github",
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
        [{ _tag: "Issue", workspace: registration.id, id: WorkItemId.make("#1") }],
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
});
