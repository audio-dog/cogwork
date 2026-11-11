import {
  IssueTrackerError,
  type ParkReason,
  WorkItemId,
  type WorkItemRef,
  WorkspaceConfig,
  WorkspaceId,
} from "@cogwork/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { TestClock } from "effect/testing";
import { bootControlStoreLayer } from "./control-store";
import { makeControlStoreCoordination } from "./coordination-control-store";
import { IssueTracker, makeEmpty } from "./issue-tracker";
import { withParkNotices } from "./park-notice";
import { readOnlyRegistry, WorkspaceRegistry } from "./registry";

interface PostedComment {
  readonly workspace: string;
  readonly item: string;
  readonly body: string;
}

class PostedComments extends Context.Service<PostedComments, Ref.Ref<ReadonlyArray<PostedComment>>>()(
  "@cogwork/engine/park-notice.test/PostedComments",
) {}

const workspace = WorkspaceId.make("cogwork");
const issue = { _tag: "Issue", workspace, id: WorkItemId.make("#901") } as const satisfies WorkItemRef;
const operation = { workflow: "implement", operation: "operation" };

const registry = Layer.succeed(
  WorkspaceRegistry,
  readOnlyRegistry({
    workspaces: [
      {
        source: "test",
        contributions: [],
        config: Schema.decodeSync(WorkspaceConfig)({
          name: workspace,
          checkoutPath: "/cogwork",
          issueTracker: { type: "github" },
        }),
      },
    ],
    failures: [],
  }),
);

const tracker = (accepts: boolean) =>
  Layer.effect(
    IssueTracker,
    Effect.gen(function* () {
      const empty = yield* makeEmpty;
      const posted = yield* PostedComments;
      return {
        ...empty,
        commentIssue: (binding, item, body) =>
          accepts
            ? Ref.update(posted, (comments) => [...comments, { workspace: binding.config.name, item, body }])
            : Effect.fail(new IssueTrackerError({ reason: "unavailable", message: "GitHub is down" })),
      };
    }),
  ).pipe(Layer.provideMerge(Layer.effect(PostedComments, Ref.make<ReadonlyArray<PostedComment>>([]))));

const parkAndRead = (reason: ParkReason) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-park-notice-" });
    yield* TestClock.setTime(1);
    const view = yield* withParkNotices(makeControlStoreCoordination).pipe(
      Effect.flatMap((coordination) =>
        coordination
          .observe(issue, "issue:901", { _tag: "Unknown" })
          .pipe(Effect.andThen(coordination.park(issue, reason, operation))),
      ),
      Effect.provide(bootControlStoreLayer(path.join(directory, "control.db"))),
    );
    return { gate: view.gate(operation)._tag, posted: yield* Ref.get(yield* PostedComments) };
  });

it.effect("posts the park reason and the way to continue on the parked issue", () =>
  Effect.gen(function* () {
    const { gate, posted } = yield* parkAndRead({
      _tag: "Stuck",
      summary: "The gate commands were refused.",
    });

    assert.strictEqual(gate, "Parked");
    assert.deepStrictEqual(
      posted.map(({ workspace, item }) => ({ workspace, item })),
      [{ workspace, item: "#901" }],
    );
    assert.include(posted[0]?.body, "The gate commands were refused.");
    assert.include(posted[0]?.body, "select **Hand back**");
  }).pipe(Effect.provide(Layer.mergeAll(tracker(true), registry, NodeServices.layer))),
);

it.effect("keeps the park when the issue tracker refuses the notice", () =>
  Effect.gen(function* () {
    const { gate, posted } = yield* parkAndRead({
      _tag: "Stuck",
      summary: "The gate commands were refused.",
    });

    assert.strictEqual(gate, "Parked");
    assert.deepStrictEqual(posted, []);
  }).pipe(Effect.provide(Layer.mergeAll(tracker(false), registry, NodeServices.layer))),
);

it.effect("keeps the raw failure of an exhausted park off the issue", () =>
  Effect.gen(function* () {
    const { posted } = yield* parkAndRead({
      _tag: "Exhausted",
      reason: "Cause(HarnessError: spawn /Users/someone/.local/bin/agent ENOENT)",
    });

    assert.strictEqual(posted.length, 1);
    assert.notInclude(posted[0]?.body, "/Users/someone");
    assert.include(posted[0]?.body, "under **Attention**");
  }).pipe(Effect.provide(Layer.mergeAll(tracker(true), registry, NodeServices.layer))),
);
