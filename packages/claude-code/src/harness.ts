import type { HarnessName } from "@cogwork/contracts";
import { ExternalHarnessRuntime, Harness, HarnessBridge, Tools } from "@cogwork/engine";
import {
  CLAUDE_CODE_MODELS,
  type ClaudeCodeModel,
  type ClaudeCodeTextAdapter,
  type ClaudeCodeTextConfig,
  type ClaudeCodeTextProviderOptions,
  claudeCodeText,
} from "@tanstack/ai-claude-code";
import type { SandboxHandle } from "@tanstack/ai-sandbox";
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process";
import * as Effect from "effect/Effect";

export interface ClaudeCodeRunnerOptions {
  readonly name: HarnessName;
  readonly claudeExecutable?: string;
}

interface ClaudeCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const adapterPackageVersion = "0.6.3";
const fallbackVersion = "claude-code-1";
const supportedClaudeMajor = 2;
const versionRequirement = `>=${supportedClaudeMajor}.0.0 <${supportedClaudeMajor + 1}.0.0`;
const commandDeadline = "5 seconds";
const anthropicEnvironment = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;
const missingExecutableCodes = new Set(["ENOENT", "EACCES"]);
const missingExecutableExitCodes = new Set([126, 127]);
const missingLoginPattern = /not (?:logged|signed) in|claude (?:auth )?login/i;
const modelPattern = /['"]((?:claude-[a-z0-9-]+)|opus|sonnet|haiku|fable)['"]/gi;

const isMissingExecutableCause = (cause: unknown, seen: ReadonlySet<object> = new Set()): boolean => {
  if (typeof cause !== "object" || cause === null || seen.has(cause)) return false;
  if ("code" in cause && typeof cause.code === "string" && missingExecutableCodes.has(cause.code)) {
    return true;
  }
  const nextSeen = new Set(seen).add(cause);
  return ["error", "rawEvent", "cause"].some(
    (field) => field in cause && isMissingExecutableCause(Reflect.get(cause, field), nextSeen),
  );
};

const harnessError = (reason: Harness.HarnessError["reason"], retryable: boolean, message: string) =>
  new Harness.HarnessError({ reason, retryable, message });

const missingHarnessError = (message = "Claude Code is not installed or executable") =>
  harnessError("missing-harness", false, message);

const commandCauseError = (cause: unknown) => {
  if (isMissingExecutableCause(cause)) return missingHarnessError();
  return harnessError("launch", true, HarnessBridge.messageFromUnknown(cause));
};

const commandTimeoutError = (subject: string) =>
  harnessError("launch", true, `Claude Code did not answer ${subject} within ${commandDeadline}`);

const createProbeSandbox = Effect.fn("ClaudeCode.createProbeSandbox")(() =>
  Effect.tryPromise({
    try: () => localProcessSandbox({ dir: ".", scrubEnv: [...anthropicEnvironment] }).create({}),
    catch: commandCauseError,
  }).pipe(
    Effect.timeout(commandDeadline),
    Effect.catchTag("TimeoutError", () => commandTimeoutError("sandbox creation")),
  ),
);

const destroyProbeSandbox = (sandbox: SandboxHandle) =>
  Effect.tryPromise({ try: () => sandbox.destroy(), catch: () => null }).pipe(
    Effect.timeout(commandDeadline),
    Effect.ignore,
  );

const withProbeSandbox = <Value>(
  use: (sandbox: SandboxHandle) => Effect.Effect<Value, Harness.HarnessError>,
) => Effect.scoped(Effect.acquireUseRelease(createProbeSandbox(), use, destroyProbeSandbox));

const claudeCommand = Effect.fn("ClaudeCode.command")(
  (sandbox: SandboxHandle, executable: string, argument: string) =>
    Effect.tryPromise({
      try: (signal) => sandbox.process.exec(`${executable} ${argument}`, { signal }),
      catch: commandCauseError,
    }).pipe(
      Effect.timeout(commandDeadline),
      Effect.catchTag("TimeoutError", () => commandTimeoutError(argument)),
    ),
);

const requireCommandSuccess = (
  result: ClaudeCommandResult,
  failure: (result: ClaudeCommandResult) => Harness.HarnessError,
) => (result.exitCode === 0 ? Effect.succeed(result) : Effect.fail(failure(result)));

const commandOutput = (result: ClaudeCommandResult) => result.stdout.trim() || result.stderr.trim();

const successfulCommand = (
  sandbox: SandboxHandle,
  executable: string,
  argument: string,
  failure: (result: ClaudeCommandResult) => Harness.HarnessError,
) =>
  claudeCommand(sandbox, executable, argument).pipe(
    Effect.flatMap((result) => requireCommandSuccess(result, failure)),
  );

const successfulCommandOutput = (
  sandbox: SandboxHandle,
  executable: string,
  argument: string,
  failure: (result: ClaudeCommandResult) => Harness.HarnessError,
) => successfulCommand(sandbox, executable, argument, failure).pipe(Effect.map(commandOutput));

const installationExitError = (result: ClaudeCommandResult) => {
  if (missingExecutableExitCodes.has(result.exitCode)) return missingHarnessError();
  return harnessError("launch", false, commandOutput(result));
};

const authenticationExitError = (result: ClaudeCommandResult) =>
  harnessError("credential", false, commandOutput(result) || "Claude Code host login is unavailable");

const versionParts = (version: string) => {
  const match = version.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])] as const;
};

const versionCompatible = (version: string) => versionParts(version)?.[0] === supportedClaudeMajor;

const setupGuidance = (error: Harness.HarnessError) => {
  if (error.reason === "missing-harness") {
    return harnessError(
      error.reason,
      error.retryable,
      `Claude Code could not start. Install Claude Code, then run \`claude auth login\`. (${error.message})`,
    );
  }
  if (error.reason === "credential" || missingLoginPattern.test(error.message)) {
    return harnessError(
      "credential",
      false,
      `Claude Code host login is unavailable. Run \`claude auth login\`, then retry. (${error.message})`,
    );
  }
  return error;
};

const readinessFromFailure = (error: Harness.HarnessError) => {
  const installationStatus = error.reason === "missing-harness" ? "missing" : "unknown";
  const authenticationStatus = error.reason === "credential" ? "unavailable" : "unknown";
  return {
    operational: { status: "unavailable", retryable: error.retryable, diagnostic: error.message },
    installation: { status: installationStatus, version: null },
    compatibility: { status: "unknown", requirement: versionRequirement },
    authentication: {
      mode: "host",
      status: authenticationStatus,
      diagnostic: error.message,
    },
    diagnostics: [error.message],
  } satisfies Harness.HarnessReadiness;
};

const readinessFromVersion = (version: string, authenticationError: Harness.HarnessError | null) => {
  const compatible = versionCompatible(version);
  const authenticated = authenticationError === null;
  const incompatibilityDiagnostic = `Claude Code ${version || "unknown"} is unsupported. Update Claude Code to ${versionRequirement}.`;
  const diagnostics = [
    ...(compatible ? [] : [incompatibilityDiagnostic]),
    ...(authenticated ? [] : [authenticationError.message]),
  ];
  return {
    operational: {
      status: compatible && authenticated ? "ready" : "unavailable",
      retryable: authenticationError?.retryable ?? false,
      diagnostic: compatible
        ? (authenticationError?.message ?? "Claude Code is ready")
        : incompatibilityDiagnostic,
    },
    installation: { status: "installed", version: version || null },
    compatibility: {
      status: compatible ? "compatible" : "incompatible",
      requirement: versionRequirement,
    },
    authentication: {
      mode: "host",
      status: authenticated ? "available" : "unavailable",
      diagnostic: authenticationError?.message ?? "Claude Code host login is available",
    },
    diagnostics,
  } satisfies Harness.HarnessReadiness;
};

const readVersion = (sandbox: SandboxHandle, executable: string) =>
  successfulCommandOutput(sandbox, executable, "--version", installationExitError);

const probeAuthentication = (sandbox: SandboxHandle, executable: string) =>
  successfulCommand(sandbox, executable, "auth status --json", authenticationExitError).pipe(
    Effect.map(() => null),
    Effect.catch((error) => Effect.succeed(setupGuidance(error))),
  );

const probeReadiness = Effect.fn("ClaudeCode.readiness")((executable: string) =>
  withProbeSandbox((sandbox) =>
    Effect.gen(function* () {
      const version = yield* readVersion(sandbox, executable);
      const authenticationError = yield* probeAuthentication(sandbox, executable);
      return { version, authenticationError };
    }),
  ).pipe(Effect.mapError(setupGuidance)),
);

const claudeReadiness = Effect.fn("ClaudeCode.readinessResult")((executable: string) =>
  probeReadiness(executable).pipe(
    Effect.match({
      onFailure: readinessFromFailure,
      onSuccess: ({ version, authenticationError }) => readinessFromVersion(version, authenticationError),
    }),
  ),
);

const modelLabel = (model: string) =>
  model
    .split("-")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");

const modelChoices = (models: ReadonlyArray<ClaudeCodeModel>) =>
  [...new Set(models)].map((model) => ({ value: model, label: modelLabel(model) }));

const modelsFromHelp = (help: string) =>
  [...help.matchAll(modelPattern)].map((match) => match[1]).filter((model) => model !== undefined);

const nativeCatalog = Effect.fn("ClaudeCode.nativeCatalog")((executable: string) =>
  withProbeSandbox((sandbox) =>
    Effect.gen(function* () {
      const version = yield* readVersion(sandbox, executable);
      const help = yield* successfulCommandOutput(sandbox, executable, "--help", installationExitError);
      const models = modelChoices(modelsFromHelp(help));
      if (models.length === 0) return null;
      return {
        models,
        provenance: {
          source: "native-discovery",
          runtimeHost: "local-process",
          harnessVersion: version,
        },
      } satisfies Harness.HarnessOptionCatalog;
    }),
  ).pipe(Effect.orElseSucceed(() => null)),
);

export const claudeCodeCatalogSources = (
  executable: string,
  runtimeModels: ReadonlyArray<ClaudeCodeModel> = CLAUDE_CODE_MODELS,
) => ({
  runtime: Harness.staticCatalogSource(
    { models: modelChoices(runtimeModels) },
    { source: "tanstack-runtime", packageVersion: adapterPackageVersion },
  ),
  native: { catalog: nativeCatalog(executable) },
  fallback: Harness.staticCatalogSource(
    { models: modelChoices(["sonnet", "opus", "haiku"]) },
    { source: "cogwork-fallback", fallbackVersion },
  ),
});

const turnDiagnostics = (cause: unknown) => {
  const message = HarnessBridge.messageFromUnknown(cause);
  if (isMissingExecutableCause(cause)) return setupGuidance(missingHarnessError(message));
  if (missingLoginPattern.test(message)) return setupGuidance(harnessError("credential", false, message));
  return harnessError("turn", true, message);
};

const adapterConfig = (executable: string, sharedGitDirectory: string | null) =>
  ({
    authMode: "host",
    permissionMode: "default",
    settingSources: ["user", "project"],
    emitDiff: true,
    claudeExecutable: executable,
    ...(sharedGitDirectory ? { addDirs: [sharedGitDirectory] } : {}),
  }) satisfies ClaudeCodeTextConfig;

const providerOptions = (request: ExternalHarnessRuntime.ExternalHarnessResolvedRequest) =>
  ({
    authMode: "host",
    ...(request.identity.resumeHandle ? { sessionId: request.identity.resumeHandle } : {}),
  }) satisfies ClaudeCodeTextProviderOptions;

const descriptor = (
  options: ClaudeCodeRunnerOptions,
): ExternalHarnessRuntime.ExternalHarnessDescriptor<ClaudeCodeTextAdapter<ClaudeCodeModel>, "host"> => {
  const executable = options.claudeExecutable ?? "claude";
  return {
    name: options.name,
    sessionKind: "opaque-handle",
    capabilities: {
      execution: Harness.fullHarnessExecution,
      profile: {
        authenticationModes: ["host"],
        session: { affinity: "sandbox-lineage", fork: true, humanAttach: false },
        structuredOutput: "native",
        policyFidelity: "profile-only",
        fileEventFidelity: "native",
        usageQuality: "metered",
        readinessDiagnostics: true,
        journal: true,
        takeover: false,
      },
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
    },
    authentication: { mode: "host", reference: "Claude Code host login on this Runtime Host" },
    catalogSources: claudeCodeCatalogSources(executable),
    readiness: () => claudeReadiness(executable),
    sharedGit: "required",
    makeAdapter: ({ model, request }) =>
      claudeCodeText(model, adapterConfig(executable, request.checkout.sharedGitDirectory)),
    projectModel: (request) => request.selection.model ?? "sonnet",
    projectOptions: providerOptions,
    projectAuthentication: () => "host",
    transport: { workspaceRoot: ".", instructionProjection: "system-prompt" },
    diagnostics: turnDiagnostics,
  };
};

export const claudeCodeRunner = (options: ClaudeCodeRunnerOptions) => {
  const sandboxProvider = ExternalHarnessRuntime.trustedLocalProcessSandboxProvider({
    scrubEnv: anthropicEnvironment,
  });
  return ExternalHarnessRuntime.externalHarnessRunner(descriptor(options), {
    authentication: () => Effect.succeed({ mode: "host", secrets: {} }),
    sandboxProvider: (request) =>
      Harness.validateCheckoutDirectory(options.name, request.checkout.path).pipe(
        Effect.andThen(sandboxProvider(request)),
      ),
    sandboxPolicy: (request) => Effect.succeed(Tools.policyForProfile(request.policy)),
  });
};
