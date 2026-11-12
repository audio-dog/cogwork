import { keyOf, LineageId, WorkItemId, type WorkItemRef, WorkspaceId } from "@cogwork/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";
import { bootControlStoreLayer, controlStoreClientLayer } from "./control-store";
import { verifyCoordinationContract } from "./coordination-contract";
import { makeControlStoreCoordination } from "./coordination-control-store";

const item = {
  _tag: "SlackMessage",
  team: "T1",
  channel: "C1",
  ts: "1234.5",
} as const satisfies WorkItemRef;
const issue = {
  _tag: "Issue",
  workspace: WorkspaceId.make("workspace"),
  id: WorkItemId.make("#1"),
} as const satisfies WorkItemRef;
const operation = { workflow: "workflow", operation: "operate" };
const lineage = { root: LineageId.make(keyOf(item)), parent: null, hop: 0 };

const withCoordination = <A, E, R>(
  storePath: string,
  use: (coordination: Effect.Success<typeof makeControlStoreCoordination>) => Effect.Effect<A, E, R>,
) => Effect.flatMap(makeControlStoreCoordination, use).pipe(Effect.provide(bootControlStoreLayer(storePath)));

layer(NodeServices.layer)((it) => {
  it.effect("coordinates tracker issues in the Control store", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-issue-coordination-" });
      yield* withCoordination(path.join(directory, "control.db"), (coordination) =>
        coordination.observe(issue, "issue:1", { _tag: "Unknown" }).pipe(
          Effect.andThen(coordination.read(issue)),
          Effect.tap((view) =>
            Effect.sync(() => {
              assert.deepStrictEqual(view.revision, { observed: "issue:1", processed: null });
            }),
          ),
        ),
      );
    }),
  );

  it.effect("satisfies the shared coordination contract", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-coordination-" });
      yield* withCoordination(path.join(directory, "control.db"), (coordination) =>
        coordination
          .observe(item, "message:1", { _tag: "Unknown" })
          .pipe(Effect.andThen(verifyCoordinationContract(coordination, item))),
      );
    }),
  );

  it.effect("persists the coordination contract across a Control store restart", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-coordination-" });
      const storePath = path.join(directory, "control.db");

      const claim = yield* withCoordination(storePath, (coordination) =>
        coordination.observe(item, "message:1", { _tag: "Unknown" }).pipe(
          Effect.andThen(TestClock.setTime(10)),
          Effect.andThen(coordination.claim(item, { operation, lineage })),
          Effect.tap(() => TestClock.setTime(20)),
          Effect.tap(() => coordination.recordAttempt(item, { operation, outcome: "failed", lineage })),
          Effect.tap(() => TestClock.setTime(30)),
          Effect.tap(() => coordination.handBack(item, { by: "person", note: "try again" })),
        ),
      );

      yield* withCoordination(storePath, (coordination) =>
        coordination.read(item).pipe(
          Effect.tap((view) =>
            Effect.sync(() => {
              assert.deepStrictEqual(view.claim, claim);
              assert.strictEqual(view.barrierAtMillis, 30);
              assert.strictEqual(view.counters(operation).consecutiveFailures, 0);
            }),
          ),
          Effect.andThen(coordination.release(item, claim)),
          Effect.andThen(coordination.markProcessed(item, "message:1")),
          Effect.andThen(coordination.read(item)),
          Effect.tap((view) =>
            Effect.sync(() => {
              assert.isNull(view.claim);
              assert.deepStrictEqual(view.revision, { observed: "message:1", processed: "message:1" });
              assert.strictEqual(view.gate(operation)._tag, "Quiet");
            }),
          ),
        ),
      );
    }),
  );

  it.effect("rejects duplicate claims and stale releases", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-coordination-" });

      yield* withCoordination(path.join(directory, "control.db"), (coordination) =>
        coordination.observe(item, "message:1", { _tag: "Unknown" }).pipe(
          Effect.andThen(coordination.claim(item, { operation, lineage })),
          Effect.flatMap((claim) =>
            Effect.result(coordination.claim(item, { operation, lineage })).pipe(
              Effect.flatMap((duplicate) =>
                coordination.release(item, claim).pipe(
                  Effect.andThen(TestClock.setTime(1)),
                  Effect.andThen(coordination.claim(item, { operation, lineage })),
                  Effect.andThen(Effect.result(coordination.release(item, claim))),
                  Effect.map((stale) => [duplicate, stale] as const),
                ),
              ),
            ),
          ),
          Effect.tap(([duplicate, stale]) =>
            Effect.sync(() => {
              assert.isTrue(Result.isFailure(duplicate) && duplicate.failure.reason === "claim-held");
              assert.isTrue(Result.isFailure(stale) && stale.failure.reason === "stale-claim");
            }),
          ),
        ),
      );
    }),
  );

  it.effect("fails closed when the Control store is unavailable", () =>
    Effect.gen(function* () {
      const coordination = yield* makeControlStoreCoordination;
      const result = yield* Effect.result(coordination.read(item));
      assert.isTrue(Result.isFailure(result) && result.failure.reason === "unavailable");
    }).pipe(Effect.provide(controlStoreClientLayer(":memory:")), Effect.scoped),
  );
});
