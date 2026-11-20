import {
  type DaemonEvent,
  type ReadyToMergeItem,
  type SchedulerQueue,
  WorkflowId,
  WorkItemId,
  WorkspaceConfig,
  WorkspaceId,
} from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as DaemonEventBus from "./daemon-event-bus";
import { DaemonEventPublisher, layer as eventPublisherLayer } from "./event-publisher";
import { IssueTrackerError } from "./issue-tracker";
import type { RegisteredWorkspace } from "./projector";
import { readOnlyRegistry, WorkspaceRegistry } from "./registry-service";
import { Scheduler } from "./scheduler";
import { emptyService, SourceControlProvider } from "./source-control";
import { TriggerObservation } from "./trigger-observation";
import { memoryLayer as workflowArtifactsLayer } from "./workflow-artifact-store";

const workspaceId = Schema.decodeSync(WorkspaceId)("web");
const workspace: RegisteredWorkspace = {
  source: "test",
  contributions: [],
  config: Schema.decodeSync(WorkspaceConfig)({
    id: workspaceId,
    displayName: "Test workspace",
    checkoutPath: "/repos/web",
    issueTracker: { type: "github" },
  }),
};

const ready: ReadyToMergeItem = {
  id: Schema.decodeSync(WorkItemId)("#4"),
  title: "Fix login",
  url: "https://github.com/acme/web/pull/9",
  pr: {
    number: 9,
    url: "https://github.com/acme/web/pull/9",
    checks: "passing",
    review: "ready",
    baseDivergence: "clean",
    waitingSinceMillis: 1,
  },
};

const readFailure = new IssueTrackerError({ reason: "unavailable", message: "GitHub returned 502" });

type ReadyToMergeRead = ReadonlyArray<ReadyToMergeItem> | null;

const emptyQueue: SchedulerQueue = { queued: [] };

const publisherWithReads = (
  reads: Ref.Ref<ReadonlyArray<ReadyToMergeRead>>,
  queues: Ref.Ref<ReadonlyArray<SchedulerQueue>> = Ref.makeUnsafe<ReadonlyArray<SchedulerQueue>>([]),
) =>
  eventPublisherLayer.pipe(
    Layer.provideMerge(DaemonEventBus.layer),
    Layer.provide([
      Layer.succeed(WorkspaceRegistry, readOnlyRegistry({ workspaces: [workspace], failures: [] })),
      Layer.mock(Scheduler, {}),
      Layer.mock(TriggerObservation, {
        catalog: [],
        queue: Ref.modify(queues, ([next = emptyQueue, ...rest]) => [next, rest]),
      }),
    ]),
    Layer.provideMerge([
      workflowArtifactsLayer,
      Layer.succeed(SourceControlProvider, {
        ...emptyService,
        readyToMerge: () =>
          Ref.modify(reads, ([next = [], ...rest]) => [next, rest]).pipe(
            Effect.flatMap((next) => (next === null ? Effect.fail(readFailure) : Effect.succeed(next))),
          ),
      }),
    ]),
  );

const publishTwice = (reads: ReadonlyArray<ReadyToMergeRead>) =>
  Effect.gen(function* () {
    const subscription = yield* (yield* DaemonEventBus.DaemonEventBus).subscribe();
    const publisher = yield* DaemonEventPublisher;
    yield* publisher.publishWorkspaces();
    yield* publisher.publishWorkspaces();
    return yield* PubSub.takeAll(subscription);
  }).pipe(Effect.provide(publisherWithReads(Ref.makeUnsafe(reads))), Effect.scoped);

const itemTags = (events: ReadonlyArray<DaemonEvent>) =>
  events.filter(({ _tag }) => _tag === "ItemChanged" || _tag === "ItemRemoved").map(({ _tag }) => _tag);

describe("DaemonEventPublisher.publishWorkspaces", () => {
  it.effect("removes a Ready-to-merge item the next read no longer returns", () =>
    Effect.gen(function* () {
      const events = yield* publishTwice([[ready], []]);
      assert.deepStrictEqual(itemTags(events), ["ItemChanged", "ItemRemoved"]);
    }),
  );

  it.effect("keeps the last Ready-to-merge view when a read fails", () =>
    Effect.gen(function* () {
      const events = yield* publishTwice([[ready], null]);
      assert.deepStrictEqual(itemTags(events), ["ItemChanged", "ItemChanged"]);
    }),
  );
});

const queueOf = (...workItems: ReadonlyArray<string>): SchedulerQueue => ({
  queued: workItems.map((workItem, index) => ({
    place: index + 1,
    workspace: workspaceId,
    workItem: Schema.decodeSync(WorkItemId)(workItem),
    workflow: Schema.decodeSync(WorkflowId)("coding"),
    operation: "implement",
  })),
});

const firstQueue = queueOf("#1", "#2");
const secondQueue = queueOf("#2");

describe("DaemonEventPublisher.publishQueue", () => {
  it.effect("publishes the queue picture only when it changed", () =>
    Effect.gen(function* () {
      const subscription = yield* (yield* DaemonEventBus.DaemonEventBus).subscribe();
      const publisher = yield* DaemonEventPublisher;
      yield* publisher.publishQueue();
      yield* publisher.publishQueue();
      yield* publisher.publishQueue();

      const published = (yield* PubSub.takeAll(subscription)).flatMap((event) =>
        event._tag === "QueueChanged" ? [event.queue] : [],
      );
      assert.deepStrictEqual(published, [firstQueue, secondQueue]);
      assert.deepStrictEqual(yield* publisher.queue, secondQueue);
    }).pipe(
      Effect.provide(
        publisherWithReads(
          Ref.makeUnsafe<ReadonlyArray<ReadyToMergeRead>>([]),
          Ref.makeUnsafe<ReadonlyArray<SchedulerQueue>>([firstQueue, firstQueue, secondQueue]),
        ),
      ),
      Effect.scoped,
    ),
  );
});
