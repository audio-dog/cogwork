import { Harness } from "@cogwork/engine";
import { assert, describe, it } from "@effect/vitest";
import { EventType } from "@tanstack/ai";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import {
  authenticatedMcp,
  createSandbox,
  fakeCodexExecutable,
  freshSession,
  harnessLayer,
  initializeRepository,
  makeRequest,
  runner,
} from "./harness-fixtures";

describe("codexRunner failures", () => {
  it.layer(harnessLayer)((it) => {
    it.effect("classifies emitted Codex authentication errors after preserving the event", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* createSandbox();
          const checkoutPath = yield* initializeRepository(handle);
          const fs = yield* FileSystem.FileSystem;
          const events: Array<Harness.AgUiEvent> = [];
          const harness = Harness.make([
            runner({ codexExecutable: fakeCodexExecutable(" --fake-turn-error=not-logged-in") }),
          ]);
          const error = yield* harness
            .run(
              makeRequest({
                checkoutPath,
                session: freshSession,
                mcpSkills: authenticatedMcp("error-secret"),
              }),
            )
            .pipe(
              Stream.runForEach((event) => Effect.sync(() => events.push(event))),
              Effect.flip,
            );

          assert.isTrue(events.some((event) => event.type === EventType.RUN_ERROR));
          assert.strictEqual(error.reason, "credential");
          assert.isFalse(error.retryable);
          assert.include(error.message, "codex login");
          assert.isFalse(yield* fs.exists(`${checkoutPath}/.codex/config.toml`));
        }),
      ),
    );

    it.effect("keeps emitted provider failures retryable", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* createSandbox();
          const checkoutPath = yield* initializeRepository(handle);
          const harness = Harness.make([
            runner({ codexExecutable: fakeCodexExecutable(" --fake-turn-error=network-reset") }),
          ]);
          const error = yield* harness
            .run(makeRequest({ checkoutPath, session: freshSession }))
            .pipe(Stream.runDrain, Effect.flip);

          assert.strictEqual(error.reason, "turn");
          assert.isTrue(error.retryable);
        }),
      ),
    );

    it.effect("keeps executable wording in emitted turn failures retryable", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* createSandbox();
          const checkoutPath = yield* initializeRepository(handle);
          const harness = Harness.make([
            runner({ codexExecutable: fakeCodexExecutable(" --fake-turn-error=spawn-codex-ENOENT") }),
          ]);
          const error = yield* harness
            .run(makeRequest({ checkoutPath, session: freshSession }))
            .pipe(Stream.runDrain, Effect.flip);

          assert.strictEqual(error.reason, "turn");
          assert.isTrue(error.retryable);
        }),
      ),
    );

    it.effect("keeps incompatible wording in emitted turn failures retryable", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* createSandbox();
          const checkoutPath = yield* initializeRepository(handle);
          const harness = Harness.make([
            runner({ codexExecutable: fakeCodexExecutable(" --fake-turn-error=incompatible-tool-output") }),
          ]);
          const error = yield* harness
            .run(makeRequest({ checkoutPath, session: freshSession }))
            .pipe(Stream.runDrain, Effect.flip);

          assert.strictEqual(error.reason, "turn");
          assert.isTrue(error.retryable);
        }),
      ),
    );

    it.effect("classifies thrown native launch failures", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* createSandbox();
          const checkoutPath = yield* initializeRepository(handle);
          const harness = Harness.make([
            runner({
              makeAdapter: () => {
                throw Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" });
              },
            }),
          ]);
          const error = yield* harness
            .run(makeRequest({ checkoutPath, session: freshSession }))
            .pipe(Stream.runDrain, Effect.flip);

          assert.strictEqual(error.reason, "missing-harness");
          assert.isFalse(error.retryable);
          assert.include(error.message, "Install Codex CLI");
        }),
      ),
    );

    it.effect("reports missing, incompatible, and logged-out Runtime Hosts", () =>
      Effect.gen(function* () {
        const missing = yield* runner({ codexExecutable: "missing-codex-150" }).readiness();
        const outdated = yield* runner({
          codexExecutable: fakeCodexExecutable(" --fake-version=codex-cli_0.1.0"),
        }).readiness();
        const loggedOut = yield* runner({
          codexExecutable: fakeCodexExecutable(" --fake-login-failure"),
        }).readiness();
        const drifted = yield* runner().readiness();

        assert.strictEqual(missing.installation.status, "missing");
        assert.include(missing.diagnostics[0] ?? "", "Install Codex CLI");
        assert.strictEqual(outdated.compatibility.status, "incompatible");
        assert.include(outdated.diagnostics[0] ?? "", "Update Codex");
        assert.strictEqual(loggedOut.authentication.status, "unavailable");
        assert.include(loggedOut.authentication.diagnostic, "codex login");
        assert.include(drifted.diagnostics[0] ?? "", "catalog was generated against Codex 0.154.0");
      }),
    );
  });
});
