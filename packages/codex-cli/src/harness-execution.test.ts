import { agUiIsFileDiffEvent, ImplementStageResult } from "@cogwork/contracts";
import { Harness, SessionStore } from "@cogwork/engine";
import { assert, describe, it } from "@effect/vitest";
import { EventType } from "@tanstack/ai";
import { type CodexTextConfig, codexText } from "@tanstack/ai-codex";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { codexRunner } from "./harness";
import {
  authenticatedMcp,
  collectEvents,
  createSandbox,
  fakeCodexExecutable,
  freshSession,
  harnessLayer,
  initializeRepository,
  linkedWorktree,
  makeRequest,
  name,
  resumedSession,
  runId,
  runInRepository,
  runner,
  sessionHandles,
  sessionStore,
  structuredCapture,
  structuredCompletions,
} from "./harness-fixtures";

describe("codexRunner execution", () => {
  it.layer(harnessLayer)((it) => {
    it.effect(
      "preserves native events, metered usage, and one structured result",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* createSandbox();
            const events = yield* runInRepository(
              Harness.make([runner({ codexExecutable: fakeCodexExecutable(" --emit-change") })]),
              handle,
            );
            const capture = yield* structuredCapture(events);

            assert.lengthOf(structuredCompletions(events), 1);
            assert.include(capture.args, "--output-schema");
            assert.deepNestedInclude(
              events.find((event) => event.type === EventType.RUN_STARTED),
              { runId, threadId: freshSession },
            );
            assert.isTrue(events.some((event) => event.type === EventType.TEXT_MESSAGE_CONTENT));
            assert.isTrue(events.some((event) => event.type === EventType.CUSTOM));
            const fileDiff = events.find(agUiIsFileDiffEvent);
            if (!fileDiff) return yield* Effect.die(new Error("Codex emitted no file diff"));
            assert.strictEqual(fileDiff.value.path, "tracked.txt");
            assert.include(fileDiff.value.diff, "+changed by Codex");
            assert.deepNestedInclude(events.at(-1), {
              type: EventType.RUN_FINISHED,
              usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
            });
          }),
        ),
      10_000,
    );

    it.effect("resumes through the native Codex thread handle", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* createSandbox();
          const harness = Harness.make([runner()]);
          const fresh = yield* runInRepository(harness, handle, { prompt: "first prompt" });
          const nativeHandle = sessionHandles(fresh)[0];
          if (!nativeHandle) return assert.fail("fresh Codex run emitted no session handle");
          const resumed = yield* collectEvents(
            harness.run(
              makeRequest({
                checkoutPath: handle.id,
                session: resumedSession,
                prompt: "current prompt",
              }),
            ),
          ).pipe(
            Effect.provideService(SessionStore.SessionStore, {
              ...sessionStore,
              resumeHandle: () => Effect.succeed(nativeHandle),
            }),
          );
          const capture = yield* structuredCapture(resumed);

          assert.include(capture.args, "resume");
          assert.include(capture.args, nativeHandle);
          assert.include(capture.prompt, "current prompt");
          assert.notInclude(capture.prompt, "first prompt");
          assert.deepNestedInclude(
            resumed.find((event) => event.type === EventType.RUN_STARTED),
            { runId, threadId: resumedSession },
          );
        }),
      ),
    );

    it.effect("grants linked Worktrees their shared Git metadata", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* createSandbox();
          const { checkoutPath, commonDirectory } = yield* linkedWorktree(handle);
          const calls: Array<CodexTextConfig> = [];
          const harness = Harness.make([
            runner({
              makeAdapter: (model, config) => {
                calls.push(config);
                return codexText(model, config);
              },
            }),
          ]);
          yield* harness.run(makeRequest({ checkoutPath, session: freshSession })).pipe(Stream.runDrain);

          assert.deepStrictEqual(calls[0]?.additionalDirectories, [commonDirectory]);
        }),
      ),
    );

    it.effect("terminates the Codex child when the Harness stream is cancelled", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* createSandbox();
          const checkoutPath = yield* initializeRepository(handle);
          const fs = yield* FileSystem.FileSystem;
          const harness = Harness.make([runner({ codexExecutable: fakeCodexExecutable(" --hang") })]);

          yield* harness
            .run(
              makeRequest({
                checkoutPath,
                session: freshSession,
                mcpSkills: authenticatedMcp("abort-secret"),
              }),
            )
            .pipe(Stream.take(2), Stream.runDrain);

          const pid = yield* Schema.decodeEffect(Schema.FiniteFromString)(
            yield* Effect.promise(() => handle.fs.read("/workspace/.pid")),
          );
          const stopped = yield* Effect.promise(() =>
            handle.process.exec(
              `for attempt in $(seq 1 100); do state=$(ps -o stat= -p ${pid} 2>/dev/null); case "$state" in ""|Z*) exit 0 ;; esac; sleep 0.01; done; exit 1`,
            ),
          );
          assert.strictEqual(stopped.exitCode, 0);
          assert.isFalse(yield* fs.exists(`${checkoutPath}/.codex/config.toml`));
        }),
      ),
    );

    it.effect(
      "runs the opt-in authenticated linked-Worktree compatibility probe",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const enabled = yield* Config.string("COGWORK_LIVE_CODEX_PROBE").pipe(Config.withDefault("0"));
            if (enabled !== "1") return;
            const handle = yield* createSandbox();
            const { checkoutPath } = yield* linkedWorktree(handle);
            const harness = Harness.make([
              codexRunner({ name, environment: process.env, codexExecutable: "codex" }),
            ]);
            const events = yield* collectEvents(
              harness.run(
                makeRequest({
                  checkoutPath,
                  session: freshSession,
                  prompt:
                    "Create codex-probe.txt, add it to Git, and commit it with message codex linked worktree probe. Return the required implement result. Do not open a pull request.",
                }),
              ),
            );

            assert.lengthOf(structuredCompletions(events), 1);
            yield* Schema.decodeUnknownEffect(ImplementStageResult)(structuredCompletions(events)[0]?.object);
            const commit = yield* Effect.promise(() =>
              handle.process.exec(`git -C ${checkoutPath} log -1 --format=%s`),
            );
            assert.strictEqual(commit.exitCode, 0);
            assert.strictEqual(commit.stdout.trim(), "codex linked worktree probe");
          }),
        ),
      // A real Codex implement turn plus a commit; the 5-second vitest default can never fit it.
      600_000,
    );
  });
});
