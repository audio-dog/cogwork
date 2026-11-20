import { Harness } from "@cogwork/engine";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { claudeCodeRunner } from "./harness";
import {
  byokAuthentication,
  byokHarnessLayer,
  CredentialVersion,
  captureFrom,
  containsString,
  fakeClaudeExecutable,
  makeLiveHarness,
  makeRequest,
  missingByokHarnessLayer,
  name,
  rotatingByokHarnessLayer,
} from "./harness-fixtures";

describe("Claude Code BYOK Harness", { timeout: 30_000 }, () => {
  it.layer(byokHarnessLayer)((it) => {
    it.effect("reports BYOK availability without requiring host login", () =>
      Effect.gen(function* () {
        const readiness = yield* claudeCodeRunner({
          name,
          authentication: byokAuthentication,
          claudeExecutable: fakeClaudeExecutable(" --not-authenticated"),
        }).readiness();

        assert.strictEqual(readiness.operational.status, "ready");
        assert.deepStrictEqual(readiness.authentication, {
          mode: "byok",
          status: "available",
          diagnostic: "Anthropic provider key is available",
        });
      }),
    );

    it.effect("does not cache the Anthropic credential after launch preflight", () =>
      Effect.gen(function* () {
        const version = yield* CredentialVersion;
        const { handle, harness, runner } = yield* makeLiveHarness("", byokAuthentication);
        const request = makeRequest(handle.id);
        yield* runner.preflight(Harness.HarnessPreflightInput.Launch({ request }));
        yield* Ref.set(version, "two");
        const events = yield* harness.run(request).pipe(Stream.runCollect);
        const capture = yield* captureFrom(events);

        assert.strictEqual(capture.apiKeyVersion, "two");
        assert.strictEqual(capture.apiKey, "[redacted]");
      }).pipe(Effect.provide(rotatingByokHarnessLayer)),
    );

    it.effect("scrubs rejected BYOK from events and diagnostics without falling back", () =>
      Effect.gen(function* () {
        const { handle, harness } = yield* makeLiveHarness(" --api-key-run-error", byokAuthentication);
        const seen = yield* Ref.make<ReadonlyArray<Harness.AgUiEvent>>([]);
        const error = yield* harness.run(makeRequest(handle.id)).pipe(
          Stream.tap((event) => Ref.update(seen, (events) => [...events, event])),
          Stream.runDrain,
          Effect.flip,
        );
        const events = yield* Ref.get(seen);

        assert.strictEqual(error.reason, "credential");
        assert.isFalse(error.retryable);
        assert.include(error.message, "[redacted]");
        assert.notInclude(error.message, "anthropic-test-key-one");
        assert.include(error.message, "cogwork login key --provider anthropic");
        assert.isTrue(containsString(events, "[redacted]"));
        assert.isFalse(containsString(events, "anthropic-test-key-one"));
      }),
    );

    it.effect("classifies an unqualified Anthropic authentication error as a rejected BYOK key", () =>
      Effect.gen(function* () {
        const { handle, harness } = yield* makeLiveHarness(
          " --unqualified-api-key-run-error",
          byokAuthentication,
        );
        const error = yield* harness.run(makeRequest(handle.id)).pipe(Stream.runDrain, Effect.flip);

        assert.strictEqual(error.reason, "credential");
        assert.isFalse(error.retryable);
        assert.include(error.message, "cogwork login key --provider anthropic");
      }),
    );

    it.effect("keeps MCP API-key failures independent from Anthropic BYOK", () =>
      Effect.gen(function* () {
        const { handle, harness } = yield* makeLiveHarness(" --mcp-api-key-run-error", byokAuthentication);
        const error = yield* harness
          .run(makeRequest(handle.id, { mcp: true }))
          .pipe(Stream.runDrain, Effect.flip);

        assert.strictEqual(error.reason, "turn");
        assert.isTrue(error.retryable);
        assert.include(error.message, "MCP server invalid API key");
        assert.notInclude(error.message, "cogwork login key --provider anthropic");
      }),
    );
  });

  it.layer(missingByokHarnessLayer)((it) => {
    it.effect("reports a missing selected BYOK credential as actionable setup failure", () =>
      Effect.gen(function* () {
        const runner = claudeCodeRunner({
          name,
          authentication: byokAuthentication,
          claudeExecutable: fakeClaudeExecutable(),
        });
        const readiness = yield* runner.readiness();
        const error = yield* Harness.make([runner]).preflight(name, "full", "sonnet").pipe(Effect.flip);

        assert.strictEqual(readiness.operational.status, "unavailable");
        assert.isFalse(readiness.operational.retryable);
        assert.strictEqual(readiness.authentication.mode, "byok");
        assert.strictEqual(readiness.authentication.status, "unavailable");
        assert.include(readiness.authentication.diagnostic, "cogwork login key --provider anthropic");
        assert.strictEqual(error.reason, "credential");
        assert.isFalse(error.retryable);
        assert.include(error.message, "cogwork login key --provider anthropic");
        const launchError = yield* runner
          .preflight(
            Harness.HarnessPreflightInput.Launch({
              request: makeRequest(process.cwd()),
            }),
          )
          .pipe(Effect.flip);
        assert.strictEqual(launchError.reason, "credential");
        assert.include(launchError.message, "cogwork login key --provider anthropic");
      }),
    );
  });
});
