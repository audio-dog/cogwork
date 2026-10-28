import { WorkItemId } from "@cogwork/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { bootControlStoreLayer, controlStoreClientLayer } from "./control-store";
import {
  type ControlStoreCoordinationService,
  makeControlStoreCoordination,
} from "./coordination-control-store";

const itemId = Schema.decodeSync(WorkItemId);

const withCoordination = <A, E, R>(
  storePath: string,
  use: (adapter: ControlStoreCoordinationService) => Effect.Effect<A, E, R>,
) => Effect.flatMap(makeControlStoreCoordination, use).pipe(Effect.provide(bootControlStoreLayer(storePath)));

layer(NodeServices.layer)((it) => {
  it.effect("persists trackerless coordination across a Control store restart", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-coordination-" });
      const storePath = path.join(directory, "control.db");
      const item = itemId("slack:T1:C1:1234.5");
      const root = itemId("slack:T1:C1:1000.0");
      const parent = itemId("slack:T1:C1:1200.0");
      const claim = {
        by: "cogwork",
        claimedAtMillis: 10,
        stage: "implement",
        lineageRoot: root,
        lineageParent: parent,
      } as const;

      yield* withCoordination(storePath, (adapter) =>
        adapter.observeSourceRevision(item, "message:1").pipe(
          Effect.andThen(adapter.markSourceRevisionProcessed(item, "message:1")),
          Effect.andThen(adapter.observeSourceRevision(item, "message:2")),
          Effect.andThen(adapter.claim(item, claim)),
          Effect.andThen(
            adapter.appendAttempt(item, {
              stage: "implement",
              outcome: "failed",
              atMillis: 20,
              lineageRoot: root,
              lineageParent: parent,
            }),
          ),
          Effect.andThen(adapter.appendHandback(item, { by: "taylor", atMillis: 30 })),
        ),
      );

      yield* withCoordination(storePath, (adapter) =>
        adapter.read(item).pipe(
          Effect.tap((state) =>
            Effect.sync(() =>
              assert.deepStrictEqual(state, {
                claimHeld: true,
                claim: {
                  by: "cogwork",
                  claimedAtMillis: 10,
                  stage: "implement",
                  lineageRoot: root,
                  lineageParent: parent,
                },
                claimedByUs: true,
                attempts: [
                  {
                    stage: "implement",
                    outcome: "failed",
                    atMillis: 20,
                    lineageRoot: root,
                    lineageParent: parent,
                  },
                ],
                handback: { by: "taylor", atMillis: 30 },
              }),
            ),
          ),
          Effect.andThen(adapter.readSourceRevisions(item)),
          Effect.tap((revisions) =>
            Effect.sync(() =>
              assert.deepStrictEqual(revisions, {
                observed: "message:2",
                processed: "message:1",
              }),
            ),
          ),
          Effect.andThen(adapter.release(item, claim)),
          Effect.andThen(adapter.read(item)),
          Effect.tap((state) => Effect.sync(() => assert.isNull(state.claim))),
        ),
      );
    }),
  );

  it.effect("keeps source revisions monotonic when old observations and processing replay", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-coordination-" });
      const item = itemId("slack:T1:C1:revision-order");

      yield* withCoordination(path.join(directory, "control.db"), (adapter) =>
        adapter.observeSourceRevision(item, "message:1").pipe(
          Effect.andThen(adapter.markSourceRevisionProcessed(item, "message:1")),
          Effect.andThen(adapter.observeSourceRevision(item, "message:2")),
          Effect.andThen(adapter.observeSourceRevision(item, "message:1")),
          Effect.andThen(adapter.markSourceRevisionProcessed(item, "message:1")),
          Effect.andThen(adapter.readSourceRevisions(item)),
          Effect.tap((revisions) =>
            Effect.sync(() =>
              assert.deepStrictEqual(revisions, { observed: "message:2", processed: "message:1" }),
            ),
          ),
          Effect.andThen(adapter.markSourceRevisionProcessed(item, "message:2")),
          Effect.andThen(adapter.markSourceRevisionProcessed(item, "message:1")),
          Effect.andThen(adapter.readSourceRevisions(item)),
          Effect.tap((revisions) =>
            Effect.sync(() =>
              assert.deepStrictEqual(revisions, { observed: "message:2", processed: "message:2" }),
            ),
          ),
        ),
      );
    }),
  );

  it.effect("rejects a second Claim and a stale release", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-coordination-" });
      const item = itemId("slack:T1:C1:claim-order");
      const root = itemId("slack:T1:C1:root");
      const first = {
        by: "cogwork",
        claimedAtMillis: 10,
        lineageRoot: root,
        lineageParent: null,
      } as const;
      const second = { ...first, claimedAtMillis: 11 };

      yield* withCoordination(path.join(directory, "control.db"), (adapter) =>
        adapter.observeSourceRevision(item, "message:1").pipe(
          Effect.andThen(adapter.claim(item, first)),
          Effect.andThen(Effect.result(adapter.claim(item, second))),
          Effect.tap((duplicate) =>
            Effect.sync(() => {
              if (Result.isSuccess(duplicate)) return assert.fail("second Claim was accepted");
              assert.strictEqual(duplicate.failure.message, "item already has an active Claim");
            }),
          ),
          Effect.andThen(adapter.release(item, first)),
          Effect.andThen(adapter.claim(item, second)),
          Effect.andThen(Effect.result(adapter.release(item, first))),
          Effect.tap((staleRelease) =>
            Effect.sync(() => {
              if (Result.isSuccess(staleRelease)) return assert.fail("stale release was accepted");
              assert.strictEqual(
                staleRelease.failure.message,
                "active Claim does not match the expected Claim",
              );
            }),
          ),
          Effect.andThen(adapter.read(item)),
          Effect.tap((state) => Effect.sync(() => assert.deepStrictEqual(state.claim, second))),
        ),
      );
    }),
  );

  it.effect("rejects Control store records without lineage", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-coordination-" });
      const item = itemId("slack:T1:C1:missing-lineage");

      yield* withCoordination(path.join(directory, "control.db"), (adapter) =>
        adapter.observeSourceRevision(item, "message:1").pipe(
          Effect.andThen(Effect.result(adapter.claim(item, { by: "cogwork", claimedAtMillis: 10 }))),
          Effect.tap((result) =>
            Effect.sync(() => {
              if (Result.isSuccess(result)) return assert.fail("lineage-free Claim was accepted");
              assert.strictEqual(result.failure.message, "lineage root and parent are required");
            }),
          ),
        ),
      );
    }),
  );

  it.effect("fails closed when the Control store is unavailable", () =>
    Effect.result(makeControlStoreCoordination).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          if (Result.isSuccess(result)) return assert.fail("unavailable Control store was accepted");
          assert.strictEqual(result.failure.operation, "open Control store");
          assert.isTrue(result.failure.retryable);
        }),
      ),
      Effect.provide(controlStoreClientLayer(":memory:")),
      Effect.scoped,
    ),
  );
});
