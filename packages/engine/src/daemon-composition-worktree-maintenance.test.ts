import { connectionIdOf, DaemonRpcs } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as RpcClient from "effect/rpc/RpcClient";
import * as TestClock from "effect/testing/TestClock";

import {
  Fixture,
  githubSourceControl,
  githubType,
  reconcileWorktrees,
  startHeartbeats,
  testLayer,
} from "./daemon-composition-fixtures";

describe("daemon composition", () => {
  it.effect("maintains worktrees and reads pull requests once per poll interval", () =>
    Effect.gen(function* () {
      const fixture = yield* Fixture;
      const rpc = yield* RpcClient.make(DaemonRpcs);
      reconcileWorktrees.mockClear();
      yield* rpc.EstablishConnection({ establishment: { system: "github", source: { _tag: "Stored" } } });
      const connectionId = connectionIdOf("github", "owner");
      const registration = yield* rpc.RegisterWorkspace({
        registration: {
          displayName: "github",
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
        reconcileWorktrees.mock.calls.map(([workspace]) => workspace.config.id),
        [registration.id],
      );
      const heartbeatReads = pullListReads() - readsBeforeHeartbeats;
      assert.isAbove(heartbeatReads, 0);
      assert.isAtMost(heartbeatReads, 2);
    }).pipe(Effect.provide(testLayer()), Effect.scoped),
  );
});
