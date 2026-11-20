import { DaemonRpcs, WorkspaceRegistration } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as RpcClient from "effect/rpc/RpcClient";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { harnessName } from "./daemon-composition-fixtures";
import {
  advancingClock,
  SlackReviewProbe,
  SlackReviewServerFixture,
  slackReviewServerTestLayer,
} from "./daemon-composition-slack-review-fixtures";
import { Scheduler } from "./scheduler";
import { TriggerObservation } from "./trigger-observation";

describe("daemon composition", () => {
  it.effect("runs the Slack review template through the composed daemon", () =>
    Effect.gen(function* () {
      const rpc = yield* RpcClient.make(DaemonRpcs);
      const fixture = yield* SlackReviewServerFixture;
      const probe = yield* SlackReviewProbe;
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
      yield* rpc.EstablishConnection({
        establishment: { system: "github", source: { _tag: "Env", name: "GITHUB_TOKEN" } },
      });
      yield* rpc.EstablishConnection({
        establishment: { system: "slack", account: "review-team", source: { _tag: "Stored" } },
      });
      const registration = yield* Schema.decodeEffect(WorkspaceRegistration)({
        displayName: "github",
        checkoutPath: fixture.root,
        issueTracker: { type: "github", connectionId: "github/connected-account" },
        sourceControl: { type: "github", connectionId: "github/connected-account" },
        linearHistory: false,
      });
      const workspace = yield* rpc.RegisterWorkspace({ registration });
      assert.strictEqual(workspace._tag, "Registered");
      if (workspace._tag !== "Registered") return;
      yield* Ref.set(probe.workspace, workspace.id);
      const template = (yield* rpc.GetWorkflowTemplates()).find(({ id }) => id === "slack-to-github-review");
      assert.isDefined(template);
      if (template === undefined) return;
      const created = yield* rpc.CreateWorkflow({ document: template.document });
      assert.deepStrictEqual(
        created.diagnostics.filter(({ class: diagnosticClass }) =>
          ["malformed", "incomplete"].includes(diagnosticClass),
        ),
        [],
      );
      yield* rpc.PublishWorkflow({ id: created.id, revision: created.workingRevision });
      const triggerObservation = yield* TriggerObservation;
      const changes = yield* Stream.toPull(triggerObservation.changes);
      const switched = yield* rpc.SwitchWorkflow({ id: created.id, enabled: true });
      assert.isTrue(switched.workflow.enabled);
      const admissions = yield* Stream.fromPull(Effect.succeed(changes)).pipe(
        Stream.take(3),
        Stream.runCollect,
      );
      assert.lengthOf(admissions, 3);
      assert.deepStrictEqual(
        [...admissions]
          .map(({ event }) => (event.key._tag === "SlackMessage" ? event.key.ts : ""))
          .toSorted(),
        Object.values(fixture.timestamps).toSorted(),
      );
      yield* rpc.SetScheduling({ desired: "running" });
      const scheduler = yield* Scheduler;
      const picked = yield* scheduler.tick();
      yield* scheduler.awaitIdle;
      assert.strictEqual(picked, 3);

      const attention = yield* rpc.ListWorkflowAttention();
      const awaitingApproval = attention.parks.find(
        ({ item, reason }) =>
          item._tag === "SlackMessage" &&
          item.ts === fixture.timestamps.approve &&
          reason._tag === "AwaitingApproval",
      );
      const handedToYou = attention.parks.find(
        ({ item, reason }) =>
          item._tag === "SlackMessage" &&
          item.ts === fixture.timestamps.cannotReview &&
          reason._tag === "HandedToYou",
      );
      assert.isDefined(handedToYou);
      assert.isDefined(awaitingApproval);
      assert.notInclude(
        attention.parks.map(({ item }) => (item._tag === "SlackMessage" ? item.ts : "")),
        fixture.timestamps.notActionable,
      );
      assert.deepStrictEqual(
        awaitingApproval?.plan?.steps.map(({ entry, status }) => [String(entry), status]),
        [
          ["cogwork.wait-for-approval", "pending"],
          ["github.post-review", "pending"],
          ["slack.reply-in-thread", "pending"],
        ],
      );
      const requests = () => fixture.fetchStub.mock.calls.map(([input, init]) => new Request(input, init));
      const slackWriteBodies = () =>
        Effect.forEach(
          requests().filter(
            (request) =>
              request.method === "POST" &&
              ["/api/reactions.add", "/api/chat.postMessage"].includes(new URL(request.url).pathname),
          ),
          (request) => Effect.promise(() => request.json()),
        );
      const writesBeforeApproval = yield* slackWriteBodies();
      assert.deepStrictEqual(
        writesBeforeApproval
          .map((body) => ({
            name: "name" in body ? body.name : "reply",
            timestamp: "timestamp" in body ? body.timestamp : body.thread_ts,
          }))
          .toSorted((left, right) => String(left.timestamp).localeCompare(String(right.timestamp))),
        [
          { name: "eyes", timestamp: fixture.timestamps.approve },
          { name: "reply", timestamp: fixture.timestamps.approve },
          { name: "eyes", timestamp: fixture.timestamps.cannotReview },
          { name: "reply", timestamp: fixture.timestamps.cannotReview },
        ],
      );
      assert.isFalse(
        requests().some(
          (request) =>
            request.method === "POST" &&
            new URL(request.url).pathname === "/repos/owner/repo/pulls/827/reviews",
        ),
      );
      assert.isDefined(awaitingApproval?.attempt);
      assert.strictEqual(awaitingApproval?.reason._tag, "AwaitingApproval");
      const cannotApprove =
        awaitingApproval?.attempt === null ||
        awaitingApproval?.attempt === undefined ||
        awaitingApproval.reason._tag !== "AwaitingApproval";
      if (cannotApprove) return;
      yield* rpc.ApproveWorkflowPlan({
        item: awaitingApproval.item,
        attempt: awaitingApproval.attempt,
        digest: awaitingApproval.reason.digest,
      });

      const reviewRequest = requests().find(
        (request) =>
          request.method === "POST" &&
          new URL(request.url).pathname === "/repos/owner/repo/pulls/827/reviews",
      );
      assert.isDefined(reviewRequest);
      const reviewBody = yield* Effect.promise(() => reviewRequest?.json() ?? Promise.resolve({}));
      assert.strictEqual(reviewBody.event, "APPROVE");
      assert.include(reviewBody.body, "Looks good.");
      const writesAfterApproval = yield* slackWriteBodies();
      const repliedAfterApproval = writesAfterApproval.some(
        (body) =>
          body.channel === "C-review" &&
          body.text === "Reviewed #827." &&
          body.thread_ts === fixture.timestamps.approve,
      );
      assert.isTrue(repliedAfterApproval);
      assert.deepStrictEqual(yield* Ref.get(probe.pullRequestToolCalls), [
        { workspace: workspace.id, pull_request: "#827" },
        { workspace: workspace.id, pull_request: "#827" },
      ]);
    }).pipe(
      Effect.provide(slackReviewServerTestLayer()),
      Effect.provideService(Clock.Clock, advancingClock()),
      Effect.scoped,
    ),
  );
});
