import { LifecycleStage } from "@cogwork/contracts";
import { Harness, OperationPolicy, SessionStore } from "@cogwork/engine";
import { assert, describe, it } from "@effect/vitest";
import { CLAUDE_CODE_MODELS } from "@tanstack/ai-claude-code";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { claudeCodeRunner, inlineSettingsArgument } from "./harness";
import {
  adapterHasEffort,
  byokAuthentication,
  capturedDisallowedTools,
  captureFrom,
  captureOperation,
  captureRunFailure,
  companionName,
  companionRunner,
  createTestSandbox,
  destroyTestSandbox,
  fakeClaudeExecutable,
  harnessLayer,
  hostAuthentication,
  makeLiveHarness,
  makeRequest,
  NativeSandboxSettings,
  name,
  resumedSession,
  runnerWithoutRuntimeCatalog,
  sessionHandles,
  sessionStore,
  structuredObjects,
  testProcessDeadline,
} from "./harness-fixtures";

describe("Claude Code host Harness", () => {
  it.layer(harnessLayer)((it) => {
    it.effect("registers an explicit Claude authentication binding", () =>
      Effect.sync(() => {
        const hostRunner = claudeCodeRunner({ name, authentication: hostAuthentication });
        const byokRunner = claudeCodeRunner({ name, authentication: byokAuthentication });

        assert.strictEqual(hostRunner.name, name);
        assert.strictEqual(hostRunner.sessionKind, "opaque-handle");
        assert.deepStrictEqual(hostRunner.authentication, {
          mode: "host",
          reference: "Claude Code host login on this Runtime Host",
        });
        assert.deepStrictEqual(byokRunner.authentication, {
          mode: "byok",
          reference: "Anthropic provider key in the Credential store",
        });
        assert.deepStrictEqual(hostRunner.capabilities, {
          authenticationModes: ["host", "byok"],
          session: { affinity: "sandbox-lineage", fork: true, humanAttach: false },
          structuredOutput: "native",
          policyFidelity: "profile-only",
          fileEventFidelity: "terminal-only",
          usageQuality: "metered",
          readinessDiagnostics: true,
          journal: true,
          takeover: true,
        });
        assert.isFalse(adapterHasEffort);
      }),
    );

    it.effect("prefers TanStack runtime model metadata and exposes no unsupported effort", () =>
      Effect.gen(function* () {
        const harness = Harness.make([claudeCodeRunner({ name, authentication: hostAuthentication })]);
        const catalog = yield* harness.catalog(name);

        assert.deepStrictEqual(
          catalog.models.map(({ value }) => value),
          [...CLAUDE_CODE_MODELS],
        );
        assert.deepStrictEqual(catalog.provenance, {
          source: "tanstack-runtime",
          packageVersion: "0.6.4",
        });
        assert.isUndefined(catalog.efforts);
      }),
    );

    it.effect("falls through native Claude discovery to the versioned fallback with provenance", () =>
      Effect.gen(function* () {
        const nativeRunner = runnerWithoutRuntimeCatalog(fakeClaudeExecutable());
        const fallbackRunner = runnerWithoutRuntimeCatalog(fakeClaudeExecutable(" --empty-models"));
        const native = yield* Harness.make([nativeRunner]).catalog(name);
        const fallback = yield* Harness.make([fallbackRunner]).catalog(name);

        assert.deepStrictEqual(
          native.models.map(({ value }) => value),
          ["fable", "opus", "sonnet", "claude-fable-5"],
        );
        assert.deepStrictEqual(native.provenance, {
          source: "native-discovery",
          runtimeHost: "local-process",
          harnessVersion: "2.1.238 (Claude Code)",
        });
        assert.deepStrictEqual(
          fallback.models.map(({ value }) => value),
          ["sonnet", "opus", "haiku"],
        );
        assert.deepStrictEqual(fallback.provenance, {
          source: "cogwork-fallback",
          fallbackVersion: "claude-code-1",
        });
      }),
    );

    it.effect("keeps another Harness ready when Claude Code is unavailable", () =>
      Effect.gen(function* () {
        const harness = Harness.make([
          claudeCodeRunner({
            name,
            authentication: hostAuthentication,
            claudeExecutable: "missing-claude-code-152",
          }),
          companionRunner,
        ]);
        const claude = yield* harness.readiness(name);
        const companion = yield* harness.readiness(companionName);

        assert.strictEqual(claude.operational.status, "unavailable");
        assert.strictEqual(companion.operational.status, "ready");
      }),
    );

    it.effect("projects read-only policy and resumes only the owning Sandbox lineage without forking", () =>
      Effect.gen(function* () {
        const { handle, harness } = yield* makeLiveHarness();
        const events = yield* harness
          .run(makeRequest(handle.id, { profile: "read-only", session: resumedSession }))
          .pipe(Stream.runCollect);
        const capture = yield* captureFrom(events);

        assert.strictEqual(capture.resume, "fake-claude-session-1");
        assert.deepNestedInclude(
          events.find((event) => event.type === "RUN_STARTED"),
          { runId: "run-claude-test", threadId: resumedSession },
        );
        assert.isFalse(capture.forkSession);
        assert.notMatch(capture.mcpConfigArgument ?? "", /^\{/);
        assert.include(capture.args, "--disallowedTools");
        assert.include(capture.args.join(" "), "Write,Edit,MultiEdit");
        assert.include(capture.args.join(" "), "NotebookEdit");
        assert.include(capturedDisallowedTools(capture), "Bash");
        assert.strictEqual(capture.permissionMode, "acceptEdits");
        assert.include(capture.args, "--permission-prompt-tool");
      }),
    );

    it.effect(
      "projects every Operation into a non-interactive native Sandbox posture",
      () =>
        Effect.gen(function* () {
          const captures = yield* Effect.forEach(LifecycleStage.literals, captureOperation);

          for (const [operation, capture] of captures) {
            const settings = yield* Schema.decodeUnknownEffect(NativeSandboxSettings)(capture.settings);
            const readOnly = OperationPolicy.operationDefaultProfile(operation) === "read-only";
            const disallowed = capturedDisallowedTools(capture);

            assert.deepStrictEqual(settings.sandbox, {
              enabled: true,
              failIfUnavailable: true,
              allowUnsandboxedCommands: false,
              autoAllowBashIfSandboxed: !readOnly,
            });
            assert.strictEqual(capture.settingSources, "");
            assert.strictEqual(capture.permissionMode, readOnly ? "acceptEdits" : "bypassPermissions");
            assert.deepStrictEqual(
              disallowed,
              readOnly
                ? ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"]
                : ["Write", "Edit", "MultiEdit", "NotebookEdit"],
            );
          }
        }),
      10_000,
    );

    it.effect("accepts safe inline settings and rejects settings containing spaces", () =>
      Effect.gen(function* () {
        const safe = '{"sandbox":{"enabled":true}}';
        const unsafe = '{"hooks":{"PreToolUse":[{"command":"/path with space/hook"}]}}';

        assert.strictEqual(inlineSettingsArgument(safe), safe);
        const cause = yield* Effect.try({
          try: () => inlineSettingsArgument(unsafe),
          catch: (cause) => {
            if (Schema.is(Harness.HarnessError)(cause)) return cause;
            return new Harness.HarnessError({
              reason: "launch",
              retryable: false,
              message: "Inline settings threw an unexpected error",
            });
          },
        }).pipe(Effect.flip);
        assert.include(cause.message, unsafe);
        assert.strictEqual(cause.reason, "launch");
        assert.isFalse(cause.retryable);
      }),
    );

    it.effect("cancels the Claude child when its Harness stream is interrupted", () =>
      Effect.gen(function* () {
        const { handle, harness } = yield* makeLiveHarness(" --hang");

        yield* harness.run(makeRequest(handle.id)).pipe(Stream.take(2), Stream.runDrain);

        const pid = yield* Schema.decodeEffect(Schema.FiniteFromString)(
          yield* Effect.promise(() => handle.fs.read("/workspace/.claude-pid")),
        );
        const stopped = yield* Effect.promise(() =>
          handle.process.exec(
            `for attempt in $(seq 1 100); do state=$(ps -o stat= -p ${pid} 2>/dev/null); case "$state" in ""|Z*) exit 0 ;; esac; sleep 0.01; done; exit 1`,
          ),
        ).pipe(Effect.timeout(testProcessDeadline));
        assert.strictEqual(stopped.exitCode, 0);
      }),
    );

    it.effect("maps native Claude failures into retryable turn diagnostics", () =>
      Effect.gen(function* () {
        const { error, seen } = yield* captureRunFailure(" --run-error");

        assert.strictEqual(error.reason, "turn");
        assert.isTrue(error.retryable);
        assert.include(error.message, "Claude turn failed");
        assert.isTrue(seen.some((event) => event.type === "RUN_ERROR"));
      }),
    );

    it.effect("keeps service authentication failures retryable", () =>
      Effect.gen(function* () {
        const { error } = yield* captureRunFailure(" --authentication-run-error");

        assert.strictEqual(error.reason, "turn");
        assert.isTrue(error.retryable);
        assert.include(error.message, "MCP server authentication failed");
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
