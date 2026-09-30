import { Harness, SessionStore } from "@cogwork/engine";
import { assert, describe, it } from "@effect/vitest";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { claudeCodeRunner } from "./harness";
import {
  createTestSandbox,
  destroyTestSandbox,
  harnessLayer,
  hostAuthentication,
  makeLiveHarness,
  makeRequest,
  name,
  resumedSession,
  sessionHandles,
  sessionStore,
  structuredObjects,
} from "./harness-fixtures";

describe("Claude Code host Harness real Sandbox contract", { timeout: 30_000 }, () => {
  it.layer(harnessLayer)((it) => {
    it.effect("reports a real Git diff through the Sandbox seam", () =>
      Effect.gen(function* () {
        const { handle, harness } = yield* makeLiveHarness(" --emit-change");
        const events = yield* harness.run(makeRequest(handle.id)).pipe(Stream.runCollect);

        const hasSandboxFileDiff = events.some((event) => {
          const isSandboxFileDiff = event.type === "CUSTOM" && event.name === "sandbox.file.diff";
          return isSandboxFileDiff;
        });
        assert.isTrue(hasSandboxFileDiff);
      }),
    );

    it.effect(
      "probes authenticated Claude launch, Session resume, and native structured output when enabled",
      () =>
        Effect.gen(function* () {
          const enabled = yield* Config.string("COGWORK_LIVE_CLAUDE_PROBE").pipe(Config.withDefault("0"));
          if (enabled !== "1") return;
          const handle = yield* Effect.acquireRelease(createTestSandbox(), destroyTestSandbox);
          const harness = Harness.make([claudeCodeRunner({ name, authentication: hostAuthentication })]);
          const fresh = yield* harness
            .run(makeRequest(handle.id))
            .pipe(Stream.runCollect, Effect.timeout("2 minutes"));
          const handleId = sessionHandles(fresh)[0];
          if (!handleId) return assert.fail("authenticated Claude emitted no Session handle");
          assert.lengthOf(structuredObjects(fresh), 1);
          const resumed = yield* harness.run(makeRequest(handle.id, { session: resumedSession })).pipe(
            Stream.runCollect,
            Effect.provideService(SessionStore.SessionStore, {
              ...sessionStore,
              resumeHandle: () => Effect.succeed(handleId),
            }),
            Effect.timeout("2 minutes"),
          );
          assert.isTrue(sessionHandles(resumed).length > 0);
          assert.lengthOf(structuredObjects(resumed), 1);
        }),
    );
  });
});
