import { FILE_DIFF_EVENT } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { claudeCodeRunner } from "./harness";
import {
  assertSingleOccurrence,
  authenticationByMode,
  byokAuthentication,
  byokHarnessLayer,
  capturedDisallowedTools,
  captureFrom,
  containsString,
  fakeClaudeExecutable,
  freshSession,
  harnessLayer,
  hostAuthentication,
  makeLiveHarness,
  makeRequest,
  name,
  networkEnvironmentProbe,
  sessionHandles,
  structuredObjects,
  windowsEnvironmentProbe,
  withInheritedCredentialEnvironment,
} from "./harness-fixtures";

describe("Claude Code inherited environment", () => {
  it.layer(harnessLayer)((it) => {
    it.effect("diagnoses installation, compatibility, and host login separately", () =>
      Effect.gen(function* () {
        const missing = yield* claudeCodeRunner({
          name,
          authentication: hostAuthentication,
          claudeExecutable: "missing-claude-code-152",
        }).readiness();
        const outdated = yield* claudeCodeRunner({
          name,
          authentication: hostAuthentication,
          claudeExecutable: fakeClaudeExecutable(" --fake-version=2.1.82-old"),
        }).readiness();
        const loggedOut = yield* claudeCodeRunner({
          name,
          authentication: hostAuthentication,
          claudeExecutable: fakeClaudeExecutable(" --not-authenticated"),
        }).readiness();
        const scrubbed = yield* withInheritedCredentialEnvironment(
          claudeCodeRunner({
            name,
            authentication: hostAuthentication,
            claudeExecutable: fakeClaudeExecutable(" --require-clean-environment"),
          }).readiness(),
        );

        assert.strictEqual(missing.installation.status, "missing");
        assert.strictEqual(missing.authentication.status, "unknown");
        assert.include(missing.diagnostics[0] ?? "", "Install Claude Code");
        assert.strictEqual(outdated.installation.status, "installed");
        assert.strictEqual(outdated.compatibility.status, "incompatible");
        assert.strictEqual(outdated.authentication.status, "available");
        assert.strictEqual(loggedOut.installation.status, "installed");
        assert.strictEqual(loggedOut.installation.version, "2.1.238 (Claude Code)");
        assert.strictEqual(loggedOut.compatibility.status, "compatible");
        assert.strictEqual(loggedOut.authentication.status, "unavailable");
        assert.include(loggedOut.authentication.diagnostic, "claude auth login");
        assert.strictEqual(scrubbed.operational.status, "ready");
      }),
    );

    it.effect("runs host auth with mandatory Workspace projection, native events, and usage", () =>
      Effect.gen(function* () {
        const { handle, harness } = yield* makeLiveHarness(" --emit-change --commit-mcp-config");
        const events = yield* withInheritedCredentialEnvironment(
          harness.run(makeRequest(handle.id, { mcp: true })).pipe(Stream.runCollect),
        );
        const capture = yield* captureFrom(events);
        const mcpConfig = capture.mcpConfig ?? "";
        const systemPrompt = capture.systemPrompt ?? "";

        assert.strictEqual(capture.settingSources, "");
        assert.strictEqual(capture.authMode, "host");
        assert.strictEqual(capture.permissionMode, "bypassPermissions");
        assert.isNull(capture.apiKey);
        assert.isNull(capture.authToken);
        assert.strictEqual(capture.claudeConfigDir, "/tmp/cogwork-claude-config");
        assert.deepStrictEqual(capture.windowsEnvironment, windowsEnvironmentProbe);
        assert.deepStrictEqual(capture.networkEnvironment, networkEnvironmentProbe);
        assert.notInclude(capture.files, ".mcp.json");
        assert.match(capture.mcpConfigArgument ?? "", /^\{"mcpServers":/);
        assert.notInclude(capture.files, ".cogwork-mcp.json");
        assert.include(mcpConfig, "https://mcp.example.test/readonly");
        assert.include(mcpConfig, "${COGWORK_MCP_");
        assert.include(mcpConfig, "Bearer\\u0020${COGWORK_MCP_");
        assert.notInclude(mcpConfig, "mcp-test-bearer");
        assert.strictEqual(capture.mcpBearer, "[redacted]");
        assert.isTrue(capture.mcpBearerPresent);
        assert.deepStrictEqual(capturedDisallowedTools(capture), [
          "Write",
          "Edit",
          "MultiEdit",
          "NotebookEdit",
        ]);
        assert.include(capture.args, "--json-schema");
        assert.strictEqual(capture.agents, "existing repo agents\n");
        assertSingleOccurrence(systemPrompt, "global rules");
        assertSingleOccurrence(systemPrompt, "repo rules");
        assertSingleOccurrence(systemPrompt, "Operating Instructions rules");
        assertSingleOccurrence(
          systemPrompt,
          "Mandatory Operating Instructions: /home/operating-instructions/implement-agent",
        );
        assert.lengthOf(structuredObjects(events), 1);
        assert.isFalse(containsString(events, "mcp-test-bearer"));
        assert.deepStrictEqual(sessionHandles(events), ["fake-claude-session-1"]);
        assert.isNull(capture.resume);
        assert.deepNestedInclude(
          events.find((event) => event.type === "RUN_STARTED"),
          { runId: "run-claude-test", threadId: freshSession },
        );
        assert.isTrue(events.some((event) => event.type === "REASONING_MESSAGE_CONTENT"));
        assert.isTrue(events.some((event) => event.type === "TEXT_MESSAGE_CONTENT"));
        assert.isTrue(events.some((event) => event.type === "TOOL_CALL_START"));
        assert.isTrue(events.some((event) => event.type === "TOOL_CALL_RESULT"));
        assert.isTrue(events.some((event) => event.type === "CUSTOM" && event.name === FILE_DIFF_EVENT));
        assert.isFalse(events.some((event) => event.type === "CUSTOM" && event.name === "file.changed"));
        const finished = events.find((event) => event.type === "RUN_FINISHED");
        assert.deepNestedInclude(finished?.usage, {
          promptTokens: 13,
          completionTokens: 8,
          totalTokens: 21,
          providerUsageDetails: { totalCostUsd: 0.01 },
        });
        assert.isFalse(yield* Effect.promise(() => handle.fs.exists("/workspace/.mcp.json")));
        assert.isFalse(yield* Effect.promise(() => handle.fs.exists("/workspace/.cogwork-mcp.json")));
        assert.strictEqual(
          yield* Effect.promise(() => handle.fs.read("/workspace/AGENTS.md")),
          "existing repo agents\n",
        );
        const committedPaths = yield* Effect.promise(() =>
          handle.process.exec("git ls-tree -r --name-only HEAD"),
        );
        assert.notInclude(committedPaths.stdout, ".cogwork-mcp.json");
        assert.notMatch(committedPaths.stdout, /\.tanstack-projected-/);
      }),
    );
  });

  it.layer(byokHarnessLayer)((it) => {
    it.effect("scrubs source-control credentials in every authentication mode", () =>
      withInheritedCredentialEnvironment(
        Effect.forEach(Object.values(authenticationByMode), (authentication) =>
          Effect.gen(function* () {
            const { handle, harness } = yield* makeLiveHarness("", authentication);
            const events = yield* harness.run(makeRequest(handle.id)).pipe(Stream.runCollect);
            return yield* captureFrom(events);
          }),
        ).pipe(
          Effect.tap((captures) =>
            Effect.sync(() => {
              for (const capture of captures) {
                assert.isNull(capture.githubToken);
                assert.isNull(capture.ghToken);
              }
            }),
          ),
        ),
      ),
    );

    it.effect("injects and scrubs BYOK beside an MCP bearer", () =>
      Effect.gen(function* () {
        const { handle, harness } = yield* makeLiveHarness("", byokAuthentication);
        const events = yield* withInheritedCredentialEnvironment(
          harness.run(makeRequest(handle.id, { mcp: true })).pipe(Stream.runCollect),
        );
        const capture = yield* captureFrom(events);

        assert.strictEqual(capture.authMode, "host");
        assert.strictEqual(capture.apiKey, "[redacted]");
        assert.isTrue(capture.apiKeyPresent);
        assert.strictEqual(capture.apiKeyVersion, "one");
        assert.isNull(capture.authToken);
        assert.strictEqual(capture.claudeConfigDir, "/tmp/cogwork-claude-config");
        assert.strictEqual(capture.mcpBearer, "[redacted]");
        assert.isTrue(capture.mcpBearerPresent);
        assert.isFalse(containsString(events, "anthropic-test-key-one"));
        assert.isFalse(containsString(events, "mcp-test-bearer"));
        assert.notInclude(capture.args.join(" "), "anthropic-test-key-one");
        assert.notInclude(capture.files.join(" "), "anthropic-test-key-one");
      }),
    );
  });
});
