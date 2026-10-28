import { type ControlStoreFailure, WorkItemId } from "@cogwork/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { bootControlStoreLayer } from "./control-store";
import type { CoordinationAdapter } from "./coordination-adapter";
import {
  type ControlStoreCoordinationService,
  makeControlStoreCoordination,
} from "./coordination-control-store";

const itemId = Schema.decodeSync(WorkItemId);

const readCoordination = (
  adapter: CoordinationAdapter<WorkItemId, WorkItemId, ControlStoreFailure>,
  item: WorkItemId,
) => adapter.read(item);

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

      yield* withCoordination(storePath, (adapter) =>
        adapter.observeSourceRevision(item, "message:2").pipe(
          Effect.andThen(adapter.markSourceRevisionProcessed(item, "message:1")),
          Effect.andThen(
            adapter.claim(item, {
              by: "cogwork",
              claimedAtMillis: 10,
              stage: "implement",
              lineageRoot: root,
              lineageParent: parent,
            }),
          ),
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
        readCoordination(adapter, item).pipe(
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
          Effect.andThen(adapter.release(item)),
          Effect.andThen(readCoordination(adapter, item)),
          Effect.tap((state) => Effect.sync(() => assert.isNull(state.claim))),
        ),
      );
    }),
  );
});
