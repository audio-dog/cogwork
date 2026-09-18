import {
  agUiIsSessionHandleEvent,
  agUiIsStructuredOutputComplete,
  HarnessName,
  ImplementStageResult,
  type LifecycleStage,
  RunId,
  RunPlan,
  SessionId,
  stageResultJsonSchema,
  WorkItemId,
} from "@cogwork/contracts";
import {
  ContextAssembler,
  CredentialStore,
  type Harness,
  OperationPolicy,
  SessionStore,
} from "@cogwork/engine";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { assert } from "@effect/vitest";
import { codexText } from "@tanstack/ai-codex";
import { memoryPersistence } from "@tanstack/ai-persistence";
import type { SandboxHandle } from "@tanstack/ai-sandbox";
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process";
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

const harnessLayer = Layer.mergeAll(
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
  const profile = OperationPolicy.operationDefaultProfile(stage);
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

export type { RequestOverrides };
export {
  assertInsideFixture,
  authenticatedMcp,
  Capture,
  collectEvents,
  createSandbox,
  defaultModel,
  ensureSuccess,
  fakeCodexExecutable,
  fakeCodexWithRepositoryHooks,
  freshSession,
  gitFixtureEnvironment,
  harnessLayer,
  initializeRepository,
  instructions,
  linkedWorktree,
  makeRequest,
  makeTestAdapter,
  name,
  operationCapture,
  projectedMcpName,
  resumedSession,
  runId,
  runInRepository,
  runner,
  runOperation,
  sessionHandles,
  sessionStore,
  sourceWrapperPath,
  structuredCapture,
  structuredCompletions,
  unexpected,
  workItemId,
};
