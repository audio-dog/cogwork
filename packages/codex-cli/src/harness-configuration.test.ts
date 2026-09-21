import { LifecycleStage } from "@cogwork/contracts";
import { Harness } from "@cogwork/engine";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { assert, describe, it } from "@effect/vitest";
import { CODEX_MODELS, type CodexTextConfig, codexText } from "@tanstack/ai-codex";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { codexExecutableWithRepositoryHooks } from "./harness";
import {
  authenticatedMcp,
  collectEvents,
  createSandbox,
  defaultModel,
  fakeCodexExecutable,
  fakeCodexWithRepositoryHooks,
  freshSession,
  gitFixtureEnvironment,
  harnessLayer,
  initializeRepository,
  makeRequest,
  name,
  runInRepository,
  runner,
  runOperation,
  sourceWrapperPath,
  structuredCapture,
} from "./harness-fixtures";

const inheritedEnvironmentProbe = {
  CODEX_HOME: "/tmp/cogwork-codex-home",
  GITHUB_TOKEN: "inherited-github-token",
  GH_TOKEN: "inherited-gh-token",
  LINEAR_API_KEY: "inherited-linear-key",
  CODEX_API_KEY: "inherited-codex-key",
  OPENAI_API_KEY: "inherited-openai-key",
};

const restoreEnvironment = (name: string, value: unknown) =>
  typeof value === "string"
    ? Reflect.set(process.env, name, value)
    : Reflect.deleteProperty(process.env, name);

const withInheritedEnvironmentProbe = <Value, Error, Requirements>(
  effect: Effect.Effect<Value, Error, Requirements>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      Object.fromEntries(
        Object.keys(inheritedEnvironmentProbe).map((name) => [name, Reflect.get(process.env, name)]),
      ),
    ),
    () =>
      Effect.sync(() => Object.assign(process.env, inheritedEnvironmentProbe)).pipe(Effect.andThen(effect)),
    (original) =>
      Effect.sync(() => Object.entries(original).map(([name, value]) => restoreEnvironment(name, value))),
  );

describe("repository fixtures", () => {
  it.effect("keeps identity out of the repository config", () =>
    Effect.gen(function* () {
      const handle = yield* createSandbox();
      yield* initializeRepository(handle);

      const config = yield* Effect.promise(() =>
        handle.process.exec("git config --local --get-regexp '^user\\.'"),
      );
      const author = yield* Effect.promise(() => handle.process.exec("git log -1 --format='%an <%ae>'"));

      assert.strictEqual(config.exitCode, 1);
      assert.strictEqual(config.stdout, "");
      assert.strictEqual(author.stdout.trim(), "cogwork-test <cogwork-test@invalid>");
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))),
  );
});

describe("codexRunner configuration", () => {
  it("keeps the Hook wrapper independent of package files", () => {
    assert.notInclude(codexExecutableWithRepositoryHooks, sourceWrapperPath);
  });

  it.layer(harnessLayer)((it) => {
    it.effect("offers the host model catalog and honest native capabilities", () =>
      Effect.gen(function* () {
        const codex = runner();
        const harness = Harness.make([codex]);
        const catalog = yield* harness.catalog(name);

        assert.deepStrictEqual(
          catalog.models.map(({ value }) => value),
          ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", ...CODEX_MODELS],
        );
        assert.deepStrictEqual(catalog.models[0]?.options, [
          {
            type: "select",
            id: "effort",
            label: "Effort",
            values: ["minimal", "low", "medium", "high"].map((value) => ({ value, label: value })),
            defaultValue: "high",
          },
        ]);
        assert.deepStrictEqual(catalog.provenance, {
          source: "cogwork-fallback",
          fallbackVersion: "codex-0.5.4",
        });
        assert.strictEqual(codex.sessionKind, "opaque-handle");
        assert.deepStrictEqual(codex.authentication, {
          mode: "host",
          reference: "Codex host login",
        });
        assert.deepNestedInclude(codex.capabilities, {
          authenticationModes: ["host"],
          session: { affinity: "runtime-host", fork: false, humanAttach: "codex-cli" },
          structuredOutput: "native",
          policyFidelity: "none",
          fileEventFidelity: "best-effort",
          usageQuality: "metered",
          journal: true,
          takeover: true,
        });
      }),
    );

    it.effect(
      "projects host authentication and native options, granting no Git path to a checkout that owns its Git directory",
      () =>
        withInheritedEnvironmentProbe(
          Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* createSandbox();
              const calls: Array<{ readonly model: string; readonly config: CodexTextConfig }> = [];
              const harness = Harness.make([
                runner({
                  makeAdapter: (model, config) => {
                    calls.push({ model, config });
                    return codexText(model, config);
                  },
                }),
              ]);
              const events = yield* runInRepository(harness, handle);
              const capture = yield* structuredCapture(events);
              const call = calls[0];
              if (!call) return assert.fail("Codex adapter was not created");
              assert.strictEqual(call.model, defaultModel);
              assert.strictEqual(call.config.authMode, "host");
              assert.isUndefined(call.config.additionalDirectories);
              assert.isUndefined(call.config.config);
              assert.isUndefined(call.config.env);
              assert.include(capture.args, 'model_reasoning_effort="high"');
              assert.isFalse(capture.hasCodexApiKey);
              assert.isFalse(capture.hasOpenAiApiKey);
              assert.isFalse(capture.hasGithubToken);
              assert.isFalse(capture.hasGhToken);
              assert.isFalse(capture.hasLinearApiKey);
              assert.strictEqual(capture.codexHome, inheritedEnvironmentProbe.CODEX_HOME);
            }),
          ),
        ),
    );

    it.effect("rejects a missing checkout before Codex launch", () =>
      Effect.gen(function* () {
        const harness = Harness.make([runner({ codexExecutable: "/missing-codex-executable" })]);
        const error = yield* harness
          .run(makeRequest({ checkoutPath: "/missing-codex-checkout" }))
          .pipe(Stream.runDrain, Effect.flip);

        assert.strictEqual(error.reason, "workspace");
        assert.include(error.message, "/missing-codex-checkout");
      }),
    );

    it.effect(
      "projects one shared Workspace with context and fresh MCP SecretRefs",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* createSandbox();
            const checkoutPath = yield* initializeRepository(handle);
            const fs = yield* FileSystem.FileSystem;
            yield* fs.writeFileString(`${checkoutPath}/AGENTS.md`, "original repo instructions\n");
            const baseline = yield* Effect.promise(() =>
              handle.process.exec("git add AGENTS.md && git commit -m 'add repo instructions'", {
                env: gitFixtureEnvironment,
              }),
            );
            assert.strictEqual(baseline.exitCode, 0);
            const capturePath = yield* fs.makeTempFileScoped({ prefix: "codex-mcp-capture-" });
            const harness = Harness.make([
              runner({
                codexExecutable: fakeCodexExecutable(
                  ` --capture-mcp-file ${capturePath} --commit-projection`,
                ),
              }),
            ]);
            const first = yield* collectEvents(
              harness.run(
                makeRequest({
                  checkoutPath,
                  session: freshSession,
                  mcpSkills: authenticatedMcp("first-secret"),
                }),
              ),
            );
            assert.strictEqual(yield* fs.readFileString(capturePath), "first-secret");
            const rotated = yield* collectEvents(
              harness.run(
                makeRequest({
                  checkoutPath,
                  session: freshSession,
                  mcpSkills: authenticatedMcp("rotated-secret"),
                }),
              ),
            );
            assert.strictEqual(yield* fs.readFileString(capturePath), "rotated-secret");

            const capture = yield* structuredCapture(rotated);
            const serializedEvents = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))([
              ...first,
              ...rotated,
            ]);

            assert.include(capture.prompt, "global rules");
            assert.include(capture.prompt, "repo rules");
            assert.include(
              capture.prompt,
              "Mandatory Operating Instructions: /operating-instructions/implement",
            );
            assert.include(capture.prompt, "implement the issue");
            assert.isFalse(capture.hasCodexConfig);
            assert.include(capture.args.join("\n"), "bearer_token_env_var");
            assert.notInclude(capture.args.join("\n"), "rotated-secret");
            assert.isFalse(yield* fs.exists(`${checkoutPath}/.codex/config.toml`));
            assert.notInclude(serializedEvents, "first-secret");
            assert.notInclude(serializedEvents, "rotated-secret");
            assert.strictEqual(
              yield* fs.readFileString(`${checkoutPath}/AGENTS.md`),
              "original repo instructions\n",
            );
            const committedAgents = yield* Effect.promise(() =>
              handle.process.exec("git show HEAD:AGENTS.md"),
            );
            const committedPaths = yield* Effect.promise(() =>
              handle.process.exec("git ls-tree -r --name-only HEAD"),
            );
            const secretHistory = yield* Effect.promise(() =>
              handle.process.exec("git log --all -G'first-secret|rotated-secret' --format=%H"),
            );
            const authors = yield* Effect.promise(() => handle.process.exec("git log --format='%an <%ae>'"));
            assert.strictEqual(committedAgents.stdout, "original repo instructions\n");
            assert.notInclude(committedPaths.stdout, ".codex/config.toml");
            assert.notMatch(committedPaths.stdout, /\.tanstack-projected-/);
            assert.strictEqual(secretHistory.stdout, "");
            assert.deepStrictEqual(
              new Set(authors.stdout.trim().split("\n")),
              new Set(["cogwork-test <cogwork-test@invalid>"]),
            );
          }),
        ),
      10_000,
    );

    it.effect("keeps every Operation on a networked Codex Sandbox", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const executable = yield* fakeCodexWithRepositoryHooks();
          const harness = Harness.make([runner({ codexExecutable: executable })]);
          const captures = yield* Effect.forEach(LifecycleStage.literals, (stage) =>
            runOperation(harness, stage),
          );

          for (const [, capture] of captures) {
            assert.include(capture.args, "--dangerously-bypass-hook-trust");
            assert.include(capture.args, "workspace-write");
            assert.notInclude(capture.args.join("\n"), "read-only");
            assert.include(capture.args, "sandbox_workspace_write.network_access=true");
            assert.include(capture.args, 'approval_policy="never"');
            assert.notInclude(capture.args.join("\n"), "danger-full-access");
          }
        }),
      ),
    );
  });
});
