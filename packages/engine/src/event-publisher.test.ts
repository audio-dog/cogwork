import {
  type DaemonEvent,
  type ReadyToMergeItem,
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
import { readOnlyRegistry, WorkspaceRegistry } from "./registry";
import { Scheduler } from "./scheduler";
import { emptyService, SourceControlProvider } from "./source-control";
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

const publisherWithReads = (reads: Ref.Ref<ReadonlyArray<ReadyToMergeRead>>) =>
  eventPublisherLayer.pipe(
    Layer.provideMerge(DaemonEventBus.layer),
    Layer.provide([
      Layer.succeed(WorkspaceRegistry, readOnlyRegistry({ workspaces: [workspace], failures: [] })),
      Layer.mock(Scheduler, {}),
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
