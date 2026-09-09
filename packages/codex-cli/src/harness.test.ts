import {
  agUiIsFileDiffEvent,
  agUiIsSessionHandleEvent,
  agUiIsStructuredOutputComplete,
  HarnessName,
  ImplementStageResult,
  LifecycleStage,
  RunId,
  RunPlan,
  SessionId,
  stageResultJsonSchema,
  WorkItemId,
} from "@cogwork/contracts";
import { ContextAssembler, CredentialStore, Harness, OperationPolicy, SessionStore } from "@cogwork/engine";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { assert, describe, it } from "@effect/vitest";
import { EventType } from "@tanstack/ai";
import { CODEX_MODELS, type CodexTextConfig, codexText } from "@tanstack/ai-codex";
import { memoryPersistence } from "@tanstack/ai-persistence";
import type { SandboxHandle } from "@tanstack/ai-sandbox";
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {
  type CodexRunnerOptions,
  codexExecutableWithRepositoryHooks,
  codexRunner,
  defaultCodexModel,
  type MakeCodexAdapter,
} from "./harness";

const name = Schema.decodeSync(HarnessName)("codex");
const freshSession = Schema.decodeSync(SessionId)("session-codex-fresh");
const resumedSession = Schema.decodeSync(SessionId)("session-codex-resumed");
const runId = Schema.decodeSync(RunId)("run-codex-test");
const workItemId = Schema.decodeSync(WorkItemId)("#150");
// The runner's own default: the live probe runs against the real backend, and the stale
// upstream CODEX_MODELS pin is not accepted by a ChatGPT account.
const defaultModel = defaultCodexModel;

const instructions = [
  { kind: "rules" as const, source: "/home/.agents/rules/global.md", content: "global rules" },
  { kind: "repo" as const, source: "/repo/AGENTS.md", content: "repo rules" },
];

const sessionStore: SessionStore.SessionStoreService = {
  persistence: memoryPersistence(),
  resumeHandle: (session) => Effect.succeed(session === resumedSession ? "thread-123" : null),
  mint: () => Effect.die(new Error("unexpected mint")),
};

const unexpected = () => Effect.die(new Error("unexpected service access"));

const services = Layer.mergeAll(
  Layer.succeed(SessionStore.SessionStore, sessionStore),
  Layer.succeed(ContextAssembler.ContextAssembler, {
    assemble: unexpected,
    cleanup: unexpected,
  }),
  Layer.succeed(CredentialStore.CredentialStore, {
    bearerToken: unexpected,
    resolveSource: unexpected,
    persist: unexpected,
    invalidate: unexpected,
    providerKey: unexpected,
    persistProviderKey: unexpected,
    configureConnection: unexpected,
    removeConnection: unexpected,
  }),
  NodeFileSystem.layer,
  NodePath.layer,
  FetchHttpClient.layer,
);

interface RequestOverrides {
  readonly checkoutPath: string;
  readonly session?: Harness.HarnessRequest["session"];
  readonly stage?: LifecycleStage;
  readonly prompt?: string;
  readonly mcpSkills?: ReadonlyArray<Harness.ResolvedMcpSkill>;
}

const projectedMcpName = (name: string, index: number) =>
  `test__${name.toLowerCase().replace(/[^a-z0-9_]+/g, "_")}__${index}`;

const makeRequest = (overrides: RequestOverrides): Harness.HarnessRequest => {
  const stage = overrides.stage ?? "implement";
  const profile = OperationPolicy.operationPolicyProfile(stage);
  const mcpSkills = overrides.mcpSkills ?? [];
  const structuredOutput = stageResultJsonSchema(stage)["~standard"].jsonSchema.input({
    target: "draft-2020-12",
  });
  const mcp = mcpSkills.map((server, index) => ({
    identity: `test/mcp/${index}`,
    name: server.name,
    projectedName: projectedMcpName(server.name, index),
    endpoint: server.endpoint,
    authenticated: server.bearer !== null,
    unavailableReason: null,
  }));
  return {
    plan: RunPlan.make({
      id: runId,
      operation: stage,
      harness: { name, model: defaultModel, effort: "high", profile },
      instructions,
      operatingInstructions: {
        name: `${stage}-agent`,
        path: `/operating-instructions/${stage}`,
        resources: [],
      },
      tools: [],
      skills: [],
      mcp,
      subagents: [],
      commands: [],
      hooks: [],
      middleware: ["sandbox"],
      structuredOutput,
      connections: [],
      messages: [{ role: "user", content: overrides.prompt ?? "implement the issue" }],
      workContext: {
        reference: { workItem: workItemId, url: null },
        facts: {
          roles: ["ready-for-agent"],
          assignees: [],
          openBlockers: 0,
          claim: null,
          priority: "medium",
          pr: null,
        },
        observation: { generation: 1, observedAtMillis: 1 },
      },
      sandbox: { workspace: overrides.checkoutPath, policy: profile },
      persistence: { sessionKind: "opaque-handle" },
      provenance: {
        resolution: [],
        stamps: [],
        projectedNames: mcp.map(({ identity, projectedName }) => ({ identity, name: projectedName })),
        projection: [],
        observation: { generation: 1, observedAtMillis: 1 },
      },
    }),
    session: overrides.session === undefined ? freshSession : overrides.session,
    mcpCredentials: new Map(
      mcpSkills.flatMap((server, index) =>
        server.bearer ? ([[`test/mcp/${index}`, server.bearer]] as const) : [],
      ),
    ),
  };
};

const gitFixtureEnvironment = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "cogwork-test",
  GIT_AUTHOR_EMAIL: "cogwork-test@invalid",
  GIT_COMMITTER_NAME: "cogwork-test",
  GIT_COMMITTER_EMAIL: "cogwork-test@invalid",
};

const fakeCodexExecutable = (arguments_ = "") =>
  `node ${new URL("./fixtures/fake-codex.mjs", import.meta.url).pathname}${arguments_}`;

const sourceWrapperPath = new URL("./codex-with-repository-hooks", import.meta.url).pathname;

const fakeCodexWithRepositoryHooks = Effect.fn("test.fakeCodexWithRepositoryHooks")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-fake-codex-bin-" });
  const executable = path.join(directory, "codex");
  yield* fs.writeFileString(executable, `#!/bin/sh\nexec ${fakeCodexExecutable()} "$@"\n`);
  yield* fs.chmod(executable, 0o700);
  return `PATH='${directory}':"$PATH" ${codexExecutableWithRepositoryHooks}`;
});

const makeTestAdapter: MakeCodexAdapter = (model, config) =>
  codexText(model, { ...config, env: { ...config.env, ...gitFixtureEnvironment } });

const runner = (options: Partial<CodexRunnerOptions> = {}) =>
  codexRunner({
    name,
    environment: process.env,
    codexExecutable: fakeCodexExecutable(),
    makeAdapter: makeTestAdapter,
    ...options,
  });

const createSandbox = () =>
  Effect.acquireRelease(
    Effect.promise(() => localProcessSandbox({}).create({})),
    (sandbox) => Effect.promise(() => sandbox.destroy()),
  );

const ensureSuccess = (result: Awaited<ReturnType<SandboxHandle["process"]["exec"]>>) => {
  if (result.exitCode === 0) return Effect.succeed(result);
  return Effect.die(new Error(`${result.stderr}\n${result.stdout}`));
};

const assertInsideFixture = Effect.fn("test.assertInsideFixture")(function* (
  fixtureRoot: string,
  candidate: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const [realFixtureRoot, realCandidate] = yield* Effect.all([
    fs.realPath(fixtureRoot),
    fs.realPath(candidate),
  ]);
  const relative = path.relative(realFixtureRoot, realCandidate);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  return yield* Effect.die(
    new Error(`fixture repository ${realCandidate} is outside fixture root ${realFixtureRoot}`),
  );
});

const initializeRepository = Effect.fn("test.initializeRepository")(function* (handle: SandboxHandle) {
  const location = yield* Effect.promise(() => handle.process.exec("pwd -P", { env: gitFixtureEnvironment }));
  yield* ensureSuccess(location);
  yield* assertInsideFixture(handle.id, location.stdout.trim());

  const initialized = yield* Effect.promise(() =>
    handle.process.exec("git init", { env: gitFixtureEnvironment }),
  );
  yield* ensureSuccess(initialized);

  const probe = yield* Effect.promise(() =>
    handle.process.exec("git rev-parse --show-toplevel", { env: gitFixtureEnvironment }),
  );
  yield* ensureSuccess(probe);
  yield* assertInsideFixture(handle.id, probe.stdout.trim());

  const committed = yield* Effect.promise(() =>
    handle.process.exec("git commit --allow-empty -m initial", { env: gitFixtureEnvironment }),
  );
  yield* ensureSuccess(committed);
  return handle.id;
});

const linkedWorktree = (handle: SandboxHandle) =>
  Effect.gen(function* () {
    yield* initializeRepository(handle);
    const checkoutPath = `${handle.id}/linked-worktree`;
    const setup = yield* Effect.promise(() =>
      handle.process.exec(`git worktree add -b linked-worktree ${checkoutPath}`),
    );
    assert.strictEqual(setup.exitCode, 0);
    const common = yield* Effect.promise(() =>
      handle.process.exec(`git -C ${checkoutPath} rev-parse --path-format=absolute --git-common-dir`),
    );
    assert.strictEqual(common.exitCode, 0);
    const gitDirectory = yield* Effect.promise(() =>
      handle.process.exec(`git -C ${checkoutPath} rev-parse --path-format=absolute --git-dir`),
    );
    assert.strictEqual(gitDirectory.exitCode, 0);
    return {
      checkoutPath,
      commonDirectory: common.stdout.trim(),
      gitDirectory: gitDirectory.stdout.trim(),
    };
  });

const Capture = Schema.fromJsonString(
  Schema.Struct({
    args: Schema.Array(Schema.String),
    prompt: Schema.String,
    cwd: Schema.String,
    hasCodexConfig: Schema.Boolean,
    hasCodexApiKey: Schema.Boolean,
    hasOpenAiApiKey: Schema.Boolean,
    hasGithubToken: Schema.Boolean,
    hasGhToken: Schema.Boolean,
    hasLinearApiKey: Schema.Boolean,
  }),
);

const structuredCompletions = (events: ReadonlyArray<Harness.AgUiEvent>) =>
  events.flatMap((event) => (agUiIsStructuredOutputComplete(event) ? [event.value] : []));

const sessionHandles = (events: ReadonlyArray<Harness.AgUiEvent>) =>
  events.flatMap((event) => (agUiIsSessionHandleEvent(event) ? [event.value.sessionId] : []));

const collectEvents = <Error, Requirements>(stream: Stream.Stream<Harness.AgUiEvent, Error, Requirements>) =>
  Stream.runCollect(stream).pipe(Effect.map((events) => Array.from(events)));

const structuredCapture = (events: ReadonlyArray<Harness.AgUiEvent>) => {
  const completion = structuredCompletions(events)[0];
  if (!completion) return Effect.die(new Error("fake Codex emitted no structured result"));
  return Schema.decodeUnknownEffect(ImplementStageResult)(completion.object).pipe(
    Effect.flatMap((result) => Schema.decodeEffect(Capture)(result.summary)),
  );
};

const operationCapture = (stage: LifecycleStage, events: ReadonlyArray<Harness.AgUiEvent>) => {
  const object = structuredCompletions(events)[0]?.object;
  if (typeof object !== "object" || object === null) {
    return Effect.die(new Error(`fake Codex emitted no ${stage} structured result`));
  }
  const value = Reflect.get(object, stage === "triage" ? "proposal" : "summary");
  return Schema.decodeUnknownEffect(Capture)(value);
};

const runInRepository = (
  harness: Harness.HarnessService,
  handle: SandboxHandle,
  overrides: Omit<RequestOverrides, "checkoutPath"> = {},
) =>
  Effect.gen(function* () {
    const checkoutPath = yield* initializeRepository(handle);
    return yield* collectEvents(
      harness.run(makeRequest({ checkoutPath, session: freshSession, ...overrides })),
    );
  });

const runOperation = (harness: Harness.HarnessService, stage: LifecycleStage) =>
  createSandbox().pipe(
    Effect.flatMap((handle) => runInRepository(harness, handle, { stage })),
    Effect.flatMap((events) => operationCapture(stage, events)),
    Effect.map((capture) => [stage, capture] satisfies [LifecycleStage, typeof Capture.Type]),
  );

const authenticatedMcp = (secret: string): ReadonlyArray<Harness.ResolvedMcpSkill> => [
  {
    name: "linear.api",
    endpoint: "https://mcp.linear.app/mcp/readonly",
    bearer: Redacted.make(secret),
  },
];

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

describe("codexRunner", () => {
  it("keeps the Hook wrapper independent of package files", () => {
    assert.notInclude(codexExecutableWithRepositoryHooks, sourceWrapperPath);
  });

  it.layer(services)((it) => {
    it.effect("suppresses the trust-bypass notice without failing the Run", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const executable = yield* fakeCodexWithRepositoryHooks();
          const harness = Harness.make([runner({ codexExecutable: executable })]);
          const handle = yield* createSandbox();
          const events = yield* runInRepository(harness, handle);
          const serializedEvents = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(events);

          assert.isFalse(events.some((event) => event.type === EventType.RUN_ERROR));
          assert.isTrue(events.some((event) => event.type === EventType.RUN_FINISHED));
          assert.notInclude(serializedEvents, "Repository hooks will run");
        }),
      ),
    );

    it.effect("offers the host model catalog and honest native capabilities", () =>
      Effect.gen(function* () {
        const codex = runner();
        const harness = Harness.make([codex]);
        const catalog = yield* harness.catalog(name);

        assert.deepStrictEqual(
          catalog.models.map(({ value }) => value),
          ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", ...CODEX_MODELS],
        );
        assert.deepStrictEqual(
          catalog.efforts?.map(({ value }) => value),
          ["minimal", "low", "medium", "high"],
        );
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
        Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* createSandbox();
            const calls: Array<{ readonly model: string; readonly config: CodexTextConfig }> = [];
            const harness = Harness.make([
              runner({
                environment: {
                  ...process.env,
                  GITHUB_TOKEN: "inherited-github-token",
                  GH_TOKEN: "inherited-gh-token",
                  LINEAR_API_KEY: "inherited-linear-key",
                  CODEX_API_KEY: "inherited-codex-key",
                  OPENAI_API_KEY: "inherited-openai-key",
                },
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
          }),
        ),
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

    it.effect("grants linked Worktrees only the shared Git paths their own commits need", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* createSandbox();
          const { checkoutPath, commonDirectory, gitDirectory } = yield* linkedWorktree(handle);
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

          const granted = calls[0]?.additionalDirectories ?? [];
          assert.sameMembers(granted, [
            gitDirectory,
            `${commonDirectory}/objects`,
            `${commonDirectory}/refs`,
            `${commonDirectory}/logs`,
            `${commonDirectory}/packed-refs`,
            `${commonDirectory}/packed-refs.lock`,
          ]);
          assert.notInclude(granted, commonDirectory);
        }),
      ),
    );

    it.effect("grants a read-only Operation no writable Git path at all", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* createSandbox();
          const checkoutPath = yield* initializeRepository(handle);
          const calls: Array<CodexTextConfig> = [];
          const harness = Harness.make([
            runner({
              makeAdapter: (model, config) => {
                calls.push(config);
                return codexText(model, config);
              },
            }),
          ]);
          yield* harness
            .run(makeRequest({ checkoutPath, session: freshSession, stage: "triage" }))
            .pipe(Stream.runDrain);

          const call = calls[0];
          if (!call) return assert.fail("Codex adapter was not created");
          assert.isUndefined(call.additionalDirectories);
        }),
      ),
    );

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

    it.effect("reports missing, incompatible, and logged-out Runtime Hosts", () =>
      Effect.gen(function* () {
        const missing = yield* runner({ codexExecutable: "missing-codex-150" }).readiness();
        const outdated = yield* runner({
          codexExecutable: fakeCodexExecutable(" --fake-version=codex-cli_0.1.0"),
        }).readiness();
        const loggedOut = yield* runner({
          codexExecutable: fakeCodexExecutable(" --fake-login-failure"),
        }).readiness();

        assert.strictEqual(missing.installation.status, "missing");
        assert.include(missing.diagnostics[0] ?? "", "Install Codex CLI");
        assert.strictEqual(outdated.compatibility.status, "incompatible");
        assert.include(outdated.diagnostics[0] ?? "", "Update Codex");
        assert.strictEqual(loggedOut.authentication.status, "unavailable");
        assert.include(loggedOut.authentication.diagnostic, "codex login");
      }),
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
            const fs = yield* FileSystem.FileSystem;
            yield* fs.makeDirectory(`${checkoutPath}/.codex`);
            yield* fs.writeFileString(
              `${checkoutPath}/.codex/hooks.json`,
              `{
  "hooks": {
    "PostToolUse": [{
      "matcher": "apply_patch",
      "hooks": [{
        "type": "command",
        "command": "printf 'formatted by Hook\\n' > codex-hook-probe.txt"
      }]
    }]
  }
}
`,
            );
            const hookBaseline = yield* Effect.promise(() =>
              handle.process.exec(
                `git -C ${checkoutPath} add .codex/hooks.json && git -C ${checkoutPath} commit -m 'add hook probe'`,
              ),
            );
            assert.strictEqual(hookBaseline.exitCode, 0);
            const harness = Harness.make([codexRunner({ name, environment: process.env })]);
            const events = yield* collectEvents(
              harness.run(
                makeRequest({
                  checkoutPath,
                  session: freshSession,
                  prompt:
                    "Use apply_patch to create codex-hook-probe.txt with the text unformatted. Add the resulting file to Git and commit it with message codex linked worktree probe. Return the required implement result. Do not open a pull request.",
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
            const formatted = yield* Effect.promise(() =>
              handle.process.exec(`git -C ${checkoutPath} show HEAD:codex-hook-probe.txt`),
            );
            assert.strictEqual(formatted.exitCode, 0);
            assert.strictEqual(formatted.stdout, "formatted by Hook\n");
          }),
        ),
      // A real Codex implement turn plus a commit; the 5-second vitest default can never fit it.
      600_000,
    );
  });
});
