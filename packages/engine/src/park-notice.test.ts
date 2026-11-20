import {
  type ParkReason,
  WorkItemId,
  type WorkItemRef,
  WorkspaceConfig,
  WorkspaceId,
} from "@cogwork/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { TestClock } from "effect/testing";
import { makeControlStoreCoordination } from "./coordination-control-store";
import { IssueTracker, makeEmpty } from "./issue-tracker";
import { withParkNotices } from "./park-notice";
import { readOnlyRegistry, WorkspaceRegistry } from "./registry-service";
import { temporaryControlStoreLayer } from "./testing/temporary-control-store";

interface PostedComment {
  readonly workspace: string;
  readonly item: string;
  readonly body: string;
}

class TrackerWrite extends Context.Service<TrackerWrite, Deferred.Deferred<PostedComment>>()(
  "@cogwork/engine/park-notice.test/TrackerWrite",
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
          id: workspace,
          displayName: "Test workspace",
          checkoutPath: "/cogwork",
          issueTracker: { type: "github" },
        }),
      },
    ],
    failures: [],
  }),
);

const tracker = (write: Effect.Effect<void>) =>
  Layer.effect(
    IssueTracker,
    Effect.gen(function* () {
      const empty = yield* makeEmpty;
      const posted = yield* TrackerWrite;
      return {
        ...empty,
        commentIssue: (binding, item, body) =>
          Deferred.succeed(posted, { workspace: binding.config.id, item, body }).pipe(Effect.andThen(write)),
      };
    }),
  ).pipe(Layer.provideMerge(Layer.effect(TrackerWrite, Deferred.make<PostedComment>())));

const environment = (write: Effect.Effect<void>) =>
  Layer.mergeAll(tracker(write), registry, temporaryControlStoreLayer).pipe(
    Layer.provideMerge(NodeServices.layer),
  );

const park = (reason: ParkReason) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(1);
    const coordination = yield* withParkNotices(makeControlStoreCoordination);
    yield* coordination.observe(issue, "issue:901", { _tag: "Unknown" });
    const view = yield* coordination.park(issue, reason, operation);
    return { gate: view.gate(operation)._tag, posted: yield* Deferred.await(yield* TrackerWrite) };
  });

it.effect("posts the park reason and the way to continue on the parked issue", () =>
  Effect.gen(function* () {
    const { gate, posted } = yield* park({ _tag: "Stuck", summary: "The gate commands were refused." });

    assert.strictEqual(gate, "Parked");
    assert.deepStrictEqual({ workspace: posted.workspace, item: posted.item }, { workspace, item: "#901" });
    assert.include(posted.body, "The gate commands were refused.");
    assert.include(posted.body, "select **Hand back**");
  }).pipe(Effect.provide(environment(Effect.void))),
);

it.effect("returns the park while the issue tracker write is still open", () =>
  Effect.gen(function* () {
    const { gate } = yield* park({ _tag: "Stuck", summary: "The gate commands were refused." });

    assert.strictEqual(gate, "Parked");
  }).pipe(Effect.provide(environment(Effect.never))),
);

const rawFailure = "fatal: unable to access /Users/someone/.local/bin/agent";

const parksWithRawFailure: ReadonlyArray<ParkReason> = [
  { _tag: "Exhausted", reason: `Cause(HarnessError: ${rawFailure})` },
  { _tag: "WriteFailed", step: "github.open-pull-request", error: rawFailure },
  { _tag: "Cancelled", note: rawFailure },
];

parksWithRawFailure.map((reason) =>
  it.effect(`keeps the raw failure off the issue for the ${reason._tag} park`, () =>
    Effect.gen(function* () {
      const { posted } = yield* park(reason);

      assert.notInclude(posted.body, "/Users/someone");
      assert.include(posted.body, "under **Attention**");
    }).pipe(Effect.provide(environment(Effect.void))),
  ),
);

it.effect(
  "names the branch and the operation but keeps the worktree path off the issue for a WorktreeBlocked park",
  () =>
    Effect.gen(function* () {
      const { posted } = yield* park({
        _tag: "WorktreeBlocked",
        reason: "operation-in-progress",
        branch: "947",
        path: "/Users/someone/worktrees/947",
        operation: "merge",
        unmergedPaths: ["src/a.ts"],
      });

      assert.include(posted.body, "Branch 947 has a merge in progress in its worktree. Finish or abort it.");
      assert.notInclude(posted.body, "/Users/someone");
    }).pipe(Effect.provide(environment(Effect.void))),
);
