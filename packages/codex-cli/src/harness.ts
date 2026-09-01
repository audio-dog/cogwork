import type { HarnessName } from "@cogwork/contracts";
import { Harness, HarnessBridge, SessionStore } from "@cogwork/engine";
import {
  type ChatMiddleware,
  chat,
  type JSONSchema,
  type ModelMessage,
  type StreamChunk,
} from "@tanstack/ai";
import {
  type CodexModel,
  type CodexTextAdapter,
  type CodexTextConfig,
  type CodexTextProviderOptions,
  codexText,
} from "@tanstack/ai-codex";
import {
  defineSandbox,
  defineWorkspace,
  type SandboxHandle,
  type SandboxProvider,
  withSandbox,
} from "@tanstack/ai-sandbox";
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

export type CodexEffort = NonNullable<CodexTextConfig["modelReasoningEffort"]>;

export interface CodexRunnerOptions {
  readonly name: HarnessName;
  readonly environment: NodeJS.ProcessEnv;
  readonly codexExecutable?: string;
  readonly makeAdapter?: MakeCodexAdapter;
  readonly runChat?: CodexRunChat;
  readonly resolveGitMetadataDirectory?: ResolveGitMetadataDirectory;
}

export type MakeCodexAdapter = (model: CodexModel, config: CodexTextConfig) => CodexTextAdapter<CodexModel>;

export type ResolveGitMetadataDirectory = (checkoutPath: string) => Effect.Effect<string | null>;

export interface CodexRunChatOptions {
  readonly adapter: CodexTextAdapter<CodexModel>;
  readonly messages: ReadonlyArray<ModelMessage>;
  readonly systemPrompts: ReadonlyArray<string>;
  readonly middleware: ReadonlyArray<ChatMiddleware>;
  readonly abortController: AbortController;
  readonly modelOptions: CodexTextProviderOptions;
  readonly outputSchema?: JSONSchema;
}

export type CodexRunChat = (options: CodexRunChatOptions) => AsyncIterable<StreamChunk>;

const defaultRunChat: CodexRunChat = (options) =>
  chat({
    adapter: options.adapter,
    messages: [...options.messages],
    systemPrompts: [...options.systemPrompts],
    middleware: [...options.middleware],
    abortController: options.abortController,
    modelOptions: options.modelOptions,
    outputSchema: options.outputSchema,
    stream: true,
  });

const completedIteration = () => ({ done: true, value: undefined }) satisfies IteratorReturnResult<undefined>;

export const abortOnReturn = <Value>(stream: AsyncIterable<Value>, abort: () => void | Promise<void>) => ({
  [Symbol.asyncIterator]: () => {
    const iterator = stream[Symbol.asyncIterator]();
    return {
      next: () => iterator.next(),
      return: (value?: unknown) => {
        const close = () => iterator.return?.(value) ?? completedIteration();
        return Promise.resolve()
          .then(abort)
          .catch((error) => Promise.resolve(close()).then(() => Promise.reject(error)))
          .then(close);
      },
    };
  },
});

type RunPromise = <A, E>(effect: Effect.Effect<A, E, never>) => Promise<A>;

const destroySandboxHandle = (sandboxHandleRef: Ref.Ref<SandboxHandle | null>) =>
  Ref.getAndSet(sandboxHandleRef, null).pipe(
    Effect.flatMap((sandboxHandle) =>
      sandboxHandle ? Effect.promise(() => sandboxHandle.destroy()) : Effect.void,
    ),
  );

const ownRunSandbox = (
  source: SandboxProvider,
  runPromise: RunPromise,
  sandboxHandleRef: Ref.Ref<SandboxHandle | null>,
) => {
  const trackSandboxHandle = (sandboxHandle: SandboxHandle) =>
    Ref.set(sandboxHandleRef, sandboxHandle).pipe(Effect.map(() => sandboxHandle));

  return {
    name: source.name,
    capabilities: () => source.capabilities(),
    create: (input) =>
      runPromise(
        Effect.tryPromise({
          try: () => source.create(input),
          catch: codexTurnError,
        }).pipe(Effect.flatMap(trackSandboxHandle)),
      ),
    resume: () => Promise.resolve(null),
    destroy: () => runPromise(destroySandboxHandle(sandboxHandleRef)),
  } satisfies SandboxProvider;
};

const sandboxMode = (profile: Harness.OperationPolicyProfile) =>
  profile === "read-only" ? "read-only" : "workspace-write";

export const codexRuntimeConfig = (
  effort: CodexEffort,
  profile: Harness.OperationPolicyProfile,
): CodexTextConfig => ({
  approvalPolicy: "never",
  sandboxMode: sandboxMode(profile),
  ...(profile === "full" ? { networkAccessEnabled: true } : {}),
  modelReasoningEffort: effort,
});

export const renderContext = (assembled: {
  readonly layers: ReadonlyArray<{ readonly content: string }>;
  readonly operatingInstructionsPath: string;
}) => [
  ...assembled.layers.map((layer) => layer.content),
  `Mandatory Operating Instructions: ${assembled.operatingInstructionsPath}`,
];

export const codexModelOptions = (handle: string | null, effort: CodexEffort): CodexTextProviderOptions => ({
  ...(handle ? { sessionId: handle } : {}),
  modelReasoningEffort: effort,
});

const launchError = (message: string) =>
  new Harness.HarnessError({ reason: "launch", retryable: false, message });

const credentialError = (message: string) =>
  new Harness.HarnessError({ reason: "credential", retryable: false, message });

const missingExecutablePattern = /ENOENT|EACCES|command not found/i;
const missingLoginPattern = /codex login|not (?:logged|signed) in/i;
const missingExecutableCodes = new Set(["ENOENT", "EACCES"]);
const missingExecutableExitCodes = new Set([126, 127]);
const codexPreflightDeadline = "5 seconds";
const codexVersionRequirement = ">=0.149.0";
const minimumCodexVersion = [0, 149, 0] as const;

const versionAtLeast = (actual: ReadonlyArray<number>, minimum: ReadonlyArray<number>) =>
  (actual.map((part, index) => Math.sign(part - (minimum[index] ?? 0))).find((part) => part !== 0) ?? 0) >= 0;

const codexVersionCompatible = (version: string) => {
  const match = version.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (!match) return false;
  return versionAtLeast([Number(match[1]), Number(match[2]), Number(match[3])], minimumCodexVersion);
};
const gitMetadataDeadline = "5 seconds";

const isMissingExecutableCause = (cause: unknown, seen: ReadonlySet<object> = new Set()): boolean => {
  if (typeof cause !== "object" || cause === null) return false;
  if (seen.has(cause)) return false;
  if ("code" in cause && typeof cause.code === "string" && missingExecutableCodes.has(cause.code)) {
    return true;
  }
  const nextSeen = new Set(seen).add(cause);
  return ["error", "rawEvent", "cause"].some(
    (field) => field in cause && isMissingExecutableCause(Reflect.get(cause, field), nextSeen),
  );
};

const missingHarnessError = (message = "Codex CLI is not installed or executable") =>
  new Harness.HarnessError({ reason: "missing-harness", retryable: false, message });

const codexPreflightError = (cause: unknown) => {
  if (isMissingExecutableCause(cause)) return missingHarnessError();
  return launchError(HarnessBridge.messageFromUnknown(cause));
};

const codexPreflightExitError = (result: {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}) => {
  if (missingExecutableExitCodes.has(result.exitCode)) return missingHarnessError();
  return launchError(`${result.stderr}\n${result.stdout}`);
};

const codexLoginExitError = (result: {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}) => {
  if (missingExecutableExitCodes.has(result.exitCode)) return missingHarnessError();
  return credentialError(`${result.stderr}\n${result.stdout}`);
};

const codexTurnError = (cause: unknown) => {
  const message = HarnessBridge.messageFromUnknown(cause);
  if (isMissingExecutableCause(cause)) return missingHarnessError(message);
  return new Harness.HarnessError({ reason: "turn", retryable: true, message });
};

const withMessage = (error: Harness.HarnessError, message: string) =>
  new Harness.HarnessError({ reason: error.reason, retryable: error.retryable, message });

const addRemediation = (error: Harness.HarnessError) => {
  if (error.reason === "missing-harness" || missingExecutablePattern.test(error.message)) {
    return withMessage(
      error,
      `Codex CLI could not start. Install Codex CLI, then run \`codex login\`. (${error.message})`,
    );
  }
  if (error.reason === "credential" || missingLoginPattern.test(error.message)) {
    return withMessage(
      error,
      `Codex CLI is not authenticated. Run \`codex login\`, then retry. (${error.message})`,
    );
  }
  return error;
};

interface CodexCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const requireCodexSuccess = (
  result: CodexCommandResult,
  failure: (result: CodexCommandResult) => Harness.HarnessError,
) => (result.exitCode === 0 ? Effect.succeed(result) : Effect.fail(failure(result)));

const codexReadinessTimeout = (subject: string) =>
  new Harness.HarnessError({
    reason: "launch",
    retryable: true,
    message: `Codex CLI did not answer its readiness check for ${subject} within ${codexPreflightDeadline}`,
  });

const createCodexSandbox = Effect.fn("CodexRunner.createSandbox")(() =>
  Effect.tryPromise({
    try: () => localProcessSandbox({ dir: process.cwd() }).create({}),
    catch: codexPreflightError,
  }).pipe(
    Effect.timeout(codexPreflightDeadline),
    Effect.catchTag("TimeoutError", () => codexReadinessTimeout("sandbox creation")),
  ),
);

const codexCommand = Effect.fn("CodexRunner.command")(
  (sandbox: SandboxHandle, executable: string, argument: string) =>
    Effect.tryPromise({
      try: (signal) => sandbox.process.exec(`${executable} ${argument}`, { signal }),
      catch: codexPreflightError,
    }).pipe(
      Effect.timeout(codexPreflightDeadline),
      Effect.catchTag("TimeoutError", () => codexReadinessTimeout(argument)),
    ),
);

const codexPreflight = Effect.fn("CodexRunner.preflight")((executable: string) =>
  Effect.scoped(
    Effect.acquireRelease(createCodexSandbox(), (sandbox) => Effect.promise(() => sandbox.destroy())).pipe(
      Effect.flatMap((sandbox) =>
        Effect.gen(function* () {
          const version = yield* codexCommand(sandbox, executable, "--version").pipe(
            Effect.flatMap((result) => requireCodexSuccess(result, codexPreflightExitError)),
          );
          yield* codexCommand(sandbox, executable, "login status").pipe(
            Effect.flatMap((result) => requireCodexSuccess(result, codexLoginExitError)),
          );
          return version.stdout.trim() || version.stderr.trim();
        }),
      ),
    ),
  ).pipe(Effect.mapError(addRemediation)),
);

const codexReadiness = Effect.fn("CodexRunner.readiness")((executable: string) =>
  codexPreflight(executable).pipe(
    Effect.match({
      onFailure: (error) =>
        ({
          operational: {
            status: "unavailable",
            retryable: error.retryable,
            diagnostic: error.message,
          },
          installation: {
            status: error.reason === "missing-harness" ? "missing" : "unknown",
            version: null,
          },
          compatibility: { status: "unknown", requirement: null },
          authentication: {
            mode: "host",
            status: error.reason === "credential" ? "unavailable" : "unknown",
            diagnostic: error.message,
          },
          diagnostics: [error.message],
        }) satisfies Harness.HarnessReadiness,
      onSuccess: (version) => {
        const compatible = codexVersionCompatible(version);
        return {
          operational: { status: "ready", retryable: false, diagnostic: "Codex is ready" },
          installation: { status: "installed", version: version || null },
          compatibility: {
            status: compatible ? "compatible" : "incompatible",
            requirement: codexVersionRequirement,
          },
          authentication: {
            mode: "host",
            status: "available",
            diagnostic: "Codex host login is available",
          },
          diagnostics: compatible
            ? []
            : [`Codex ${version || "unknown"} is unsupported. Update Codex to ${codexVersionRequirement}.`],
        } satisfies Harness.HarnessReadiness;
      },
    }),
  ),
);
const codexEfforts: ReadonlyArray<CodexEffort> = ["minimal", "low", "medium", "high"];

const codexLaunchPreflight = Effect.fn("CodexRunner.launchPreflight")(function* (
  name: HarnessName,
  request: Harness.HarnessRequest,
) {
  const plan = request.plan;
  yield* Harness.validateCheckoutDirectory(name, plan.sandbox.workspace);
  if (plan.sandbox.policy !== plan.harness.profile) {
    return yield* new Harness.HarnessError({
      reason: "policy",
      retryable: false,
      message: "Codex Sandbox policy does not match the immutable Harness profile",
    });
  }
  if (!plan.middleware.includes("sandbox")) {
    return yield* new Harness.HarnessError({
      reason: "sandbox",
      retryable: false,
      message: "Codex Run Plan is missing mandatory Sandbox projection",
    });
  }
  const capabilities = localProcessSandbox({ dir: plan.sandbox.workspace }).capabilities();
  if (
    capabilities.fs &&
    capabilities.exec &&
    capabilities.backgroundProcesses &&
    capabilities.killableProcesses
  ) {
    return;
  }
  return yield* new Harness.HarnessError({
    reason: "sandbox",
    retryable: false,
    message: "Codex local Sandbox provider lacks mandatory process or filesystem capabilities",
  });
});

const gitMetadataDirectory = (checkoutPath: string) =>
  Effect.scoped(
    Effect.acquireRelease(
      Effect.tryPromise({
        try: () => localProcessSandbox({ dir: checkoutPath }).create({}),
        catch: () => null,
      }),
      (sandbox) => Effect.tryPromise({ try: () => sandbox.destroy(), catch: () => null }).pipe(Effect.ignore),
    ).pipe(
      Effect.flatMap((sandbox) =>
        Effect.tryPromise({
          try: (signal) =>
            sandbox.process.exec("git rev-parse --path-format=absolute --git-common-dir", { signal }),
          catch: () => null,
        }),
      ),
      Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : null)),
    ),
  ).pipe(
    Effect.timeout(gitMetadataDeadline),
    Effect.orElseSucceed(() => null),
  );

const decodeEffort = (effort: string): CodexEffort | null =>
  codexEfforts.find((candidate) => candidate === effort) ?? null;

const resolveEffort = (requested: string | null, fallback: CodexEffort) => {
  const configured = requested ?? fallback;
  const effort = decodeEffort(configured);
  if (effort) return Effect.succeed(effort);
  return Effect.fail(launchError(`unsupported Codex reasoning effort: ${configured}`));
};

const codexEnvironmentNames = [
  "HOME",
  "PATH",
  "CODEX_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
];

export const codexChildEnvironment = (environment: NodeJS.ProcessEnv) =>
  Object.fromEntries(
    codexEnvironmentNames.flatMap((name) => {
      const value = environment[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );

const mcpEnvName = (identity: string) =>
  `COGWORK_MCP_${Buffer.from(identity).toString("hex").toUpperCase()}_BEARER`;

const mcpBearerEntries = (prefix: string, envName: string, bearer: Harness.ResolvedMcpSkill["bearer"]) => {
  if (!bearer) return { configEntries: [], envEntries: [] };
  return {
    configEntries: [[`${prefix}.bearer_token_env_var`, JSON.stringify(envName)]],
    envEntries: [[envName, Redacted.value(bearer)]],
  } satisfies {
    readonly configEntries: ReadonlyArray<readonly [string, string]>;
    readonly envEntries: ReadonlyArray<readonly [string, string]>;
  };
};

const mcpEntries = (skill: Harness.ResolvedMcpSkill) => {
  const identity = skill.name;
  const prefix = `mcp_servers.${identity}`;
  const envName = mcpEnvName(identity);
  const bearer = mcpBearerEntries(prefix, envName, skill.bearer);
  const configEntries: ReadonlyArray<readonly [string, string]> = [
    [`${prefix}.url`, JSON.stringify(skill.endpoint)],
    ...bearer.configEntries,
  ];
  return { configEntries, envEntries: bearer.envEntries };
};

const mcpAdapterConfig = (
  mcpSkills: ReadonlyArray<Harness.ResolvedMcpSkill>,
  environment: NodeJS.ProcessEnv,
) => {
  const entries = mcpSkills.map(mcpEntries);
  return {
    ...(entries.length > 0
      ? { config: Object.fromEntries(entries.flatMap((entry) => entry.configEntries)) }
      : {}),
    env: {
      ...codexChildEnvironment(environment),
      ...Object.fromEntries(entries.flatMap((entry) => entry.envEntries)),
    },
  };
};

const adapterConfig = (
  effort: CodexEffort,
  profile: Harness.OperationPolicyProfile,
  codexExecutable: string | undefined,
  mcpSkills: ReadonlyArray<Harness.ResolvedMcpSkill>,
  gitDirectory: string | null,
  environment: NodeJS.ProcessEnv,
): CodexTextConfig => ({
  ...codexRuntimeConfig(effort, profile),
  ...(codexExecutable ? { codexExecutable } : {}),
  ...(gitDirectory ? { additionalDirectories: [gitDirectory] } : {}),
  ...mcpAdapterConfig(mcpSkills, environment),
});

export const codexRunner = (options: CodexRunnerOptions): Harness.HarnessRunner => {
  const makeAdapter = options.makeAdapter ?? codexText;
  const runChat = options.runChat ?? defaultRunChat;
  const resolveGitMetadataDirectory = options.resolveGitMetadataDirectory ?? gitMetadataDirectory;
  const preflightPhase = Harness.HarnessPreflightInput.$match({
    Static: () => Effect.void,
    Launch: ({ request }) => codexLaunchPreflight(options.name, request),
  });
  const preflight = Effect.fn("CodexRunner.preflight")((input: Harness.HarnessPreflightInput) =>
    preflightPhase(input),
  );
  const ambientMcpEnvironmentNames = Object.keys(options.environment).filter((name) =>
    name.startsWith("COGWORK_MCP_"),
  );

  return {
    name: options.name,
    sessionKind: "opaque-handle",
    projectedMembers: [
      "Harness Adapter",
      "Instructions",
      "Messages",
      "MCP",
      "Middleware",
      "Sandbox",
      "Structured Output",
      "Persistence",
      "Connections",
    ],
    planMiddleware: ["sandbox"],
    execution: {
      nonInteractive: true,
      worktreeConfined: true,
      profiles: ["read-only", "full"],
    },
    capabilities: {
      authenticationModes: ["host"],
      session: { affinity: "runtime-host", fork: false, humanAttach: "codex-cli" },
      structuredOutput: "native",
      policyFidelity: "profile-only",
      fileEventFidelity: "sandbox",
      usageQuality: "metered",
      readinessDiagnostics: true,
      journal: false,
      takeover: false,
    },
    authentication: { mode: "host", reference: "Codex host login" },
    catalogSources: {
      fallback: Harness.staticCatalogSource(
        {
          models: [{ value: "gpt-5.6-sol", label: "GPT-5.6 Sol" }],
          efforts: codexEfforts.map((effort) => ({ value: effort, label: effort })),
        },
        { source: "cogwork-fallback", fallbackVersion: "codex-1" },
      ),
    },
    readiness: () => codexReadiness(options.codexExecutable ?? "codex"),
    preflight,
    run: (request) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const plan = request.plan;
          const effort = yield* resolveEffort(plan.harness.effort, "high");
          const assembled = {
            layers: plan.instructions,
            operatingInstructionsPath: plan.operatingInstructions.path,
          };
          const store = yield* SessionStore.SessionStore;
          const handle = request.session ? yield* store.resumeHandle(request.session) : null;
          const model = plan.harness.model ?? "gpt-5.6-sol";
          const gitDirectory = yield* resolveGitMetadataDirectory(plan.sandbox.workspace);
          const adapter = makeAdapter(
            model,
            adapterConfig(
              effort,
              plan.harness.profile,
              options.codexExecutable,
              Harness.resolvedMcpSkills(request),
              gitDirectory,
              options.environment,
            ),
          );
          const sandboxSource = localProcessSandbox({
            dir: plan.sandbox.workspace,
            scrubEnv: [
              "GITHUB_TOKEN",
              "GH_TOKEN",
              "OPENAI_API_KEY",
              "CODEX_API_KEY",
              ...ambientMcpEnvironmentNames,
            ],
          });
          const runPromise = yield* FiberSet.makeRuntimePromise();
          const sandboxHandleRef = yield* Effect.acquireRelease(
            Ref.make<SandboxHandle | null>(null),
            destroySandboxHandle,
          );
          const sandbox = defineSandbox({
            id: `cogwork-${options.name}`,
            fileEvents: false,
            provider: ownRunSandbox(sandboxSource, runPromise, sandboxHandleRef),
            workspace: defineWorkspace({ source: { type: "none" } }),
            lifecycle: { reuse: "none", snapshot: "none", destroyOnComplete: true },
          });
          const abortController = new AbortController();
          const stream = runChat({
            adapter,
            messages: plan.messages.map(({ role, content }) => ({ role, content })),
            systemPrompts: renderContext(assembled),
            middleware: plan.middleware.includes("sandbox") ? [withSandbox(sandbox)] : [],
            abortController,
            modelOptions: codexModelOptions(handle, effort),
            outputSchema: plan.structuredOutput ?? undefined,
          });
          return HarnessBridge.bridgeChat(
            abortOnReturn(stream, () => {
              abortController.abort();
              return runPromise(destroySandboxHandle(sandboxHandleRef));
            }),
            codexTurnError,
            codexTurnError,
          ).pipe(
            Stream.mapError(addRemediation),
            Stream.ensuring(Effect.sync(() => abortController.abort())),
          );
        }),
      ),
  };
};
