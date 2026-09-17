import type { HarnessName } from "@cogwork/contracts";
import { CredentialStore, ExternalHarnessRuntime, Harness, HarnessBridge } from "@cogwork/engine";
import {
  CLAUDE_CODE_MODELS,
  type ClaudeCodeModel,
  type ClaudeCodeTextAdapter,
  type ClaudeCodeTextConfig,
  type ClaudeCodeTextProviderOptions,
  claudeCodeText,
} from "@tanstack/ai-claude-code";
import { claudeCodeByok } from "@tanstack/ai-claude-code/byok";
import { createSecrets, type SandboxHandle } from "@tanstack/ai-sandbox";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export interface ClaudeCodeRunnerOptions {
  readonly name: HarnessName;
  readonly authentication: { readonly mode: "host" } | { readonly mode: "byok" };
  readonly claudeExecutable?: string;
}

interface ClaudeCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const adapterPackageVersion = "0.6.4";
const fallbackVersion = "claude-code-1";
const supportedClaudeMajor = 2;
const minimumClaudeVersion: ReadonlyArray<number> = [2, 1, 83];
const versionRequirement = `>=${minimumClaudeVersion.join(".")} <${supportedClaudeMajor + 1}.0.0`;
const commandDeadline = "5 seconds";
const inheritedEnvironment = [
  ...ExternalHarnessRuntime.defaultInheritedEnvironment,
  ...ExternalHarnessRuntime.windowsInheritedEnvironment,
  "CLAUDE_CONFIG_DIR",
];
type ClaudeAuthenticationMode = ClaudeCodeRunnerOptions["authentication"]["mode"];
const claudeAuthenticationModes = ["host", "byok"] as const satisfies ReadonlyArray<ClaudeAuthenticationMode>;
const requiredEnvironmentName = (names: ReadonlyArray<string> | undefined) => {
  const name = names?.[0];
  if (name) return name;
  throw new Error("Claude Code BYOK declares no API-key environment name");
};
const anthropicApiKeyEnvironment = requiredEnvironmentName(claudeCodeByok.env);
const anthropicProviderAccount = {
  provider: "anthropic",
  envVars: [anthropicApiKeyEnvironment],
} as const;
const nativeAuthenticationMode = "host" as const;
const missingExecutableCodes = new Set(["ENOENT", "EACCES"]);
const missingExecutableExitCodes = new Set([126, 127]);
const missingLoginPattern = /not (?:logged|signed) in|claude (?:auth )?login/i;
const rejectedApiKeyPattern =
  /\bauthentication_error\b|\binvalid x-api-key\b|(?:claude|anthropic).{0,80}(?:api[- ]?key|x-api-key|invalid (?:credential|key))|(?:api[- ]?key|x-api-key|invalid (?:credential|key)).{0,80}(?:claude|anthropic)/i;
const authenticationProfiles = {
  host: {
    binding: { mode: "host", reference: "Claude Code host login on this Runtime Host" },
    signIn: "claude auth login",
    availableDiagnostic: "Claude Code host login is available",
    installNextStep: "Install Claude Code, then run `claude auth login`.",
    credentialGuidance: "Claude Code host login is unavailable. Run `claude auth login`, then retry.",
    failurePattern: missingLoginPattern,
  },
  byok: {
    binding: { mode: "byok", reference: "Anthropic provider key in the Credential store" },
    signIn: "cogwork login key --provider anthropic",
    availableDiagnostic: "Anthropic provider key is available",
    installNextStep: "Install Claude Code.",
    credentialGuidance:
      "Claude Code API-key authentication is unavailable. Store an Anthropic key with `cogwork login key --provider anthropic`, then retry.",
    failurePattern: rejectedApiKeyPattern,
  },
} as const satisfies Record<ClaudeAuthenticationMode, unknown>;
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
const isHarnessError = Schema.is(Harness.HarnessError);

export const inlineSettingsArgument = (value: string) => {
  if (!value.includes(" ")) return value;
  throw harnessError(
    "launch",
    false,
    `Claude Code inline settings contain a space and cannot be passed safely: ${value}`,
  );
};

const missingHarnessError = (message = "Claude Code is not installed or executable") =>
  harnessError("missing-harness", false, message);

const commandCauseError = (cause: unknown) => {
  if (isMissingExecutableCause(cause)) return missingHarnessError();
  return harnessError("launch", true, HarnessBridge.messageFromUnknown(cause));
};

const commandTimeoutError = (subject: string) =>
  harnessError("launch", true, `Claude Code did not answer ${subject} within ${commandDeadline}`);

const withProbeSandbox = <Value, Requirements>(
  use: (sandbox: SandboxHandle) => Effect.Effect<Value, Harness.HarnessError, Requirements>,
) => ExternalHarnessRuntime.withLocalProcessSandbox(".", inheritedEnvironment, commandCauseError, use);

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

const versionCompatible = (version: string) => {
  const parts = versionParts(version);
  return parts?.[0] === supportedClaudeMajor && HarnessBridge.versionAtLeast(parts, minimumClaudeVersion);
};

const setupGuidance = (mode: ClaudeAuthenticationMode, error: Harness.HarnessError) => {
  const profile = authenticationProfiles[mode];
  if (error.reason === "missing-harness") {
    return harnessError(
      error.reason,
      error.retryable,
      `Claude Code could not start. ${profile.installNextStep} (${error.message})`,
    );
  }
  if (error.reason !== "credential") return error;
  return harnessError("credential", false, `${profile.credentialGuidance} (${error.message})`);
};

const readinessFromFailure = (mode: ClaudeAuthenticationMode, error: Harness.HarnessError) => {
  const installationStatus = error.reason === "missing-harness" ? "missing" : "unknown";
  const authenticationStatus = error.reason === "credential" ? "unavailable" : "unknown";
  return {
    operational: { status: "unavailable", retryable: error.retryable, diagnostic: error.message },
    installation: { status: installationStatus, version: null },
    compatibility: { status: "unknown", requirement: versionRequirement },
    authentication: {
      mode,
      status: authenticationStatus,
      diagnostic: error.message,
    },
    diagnostics: [error.message],
  } satisfies Harness.HarnessReadiness;
};

const readinessFromVersion = (
  mode: ClaudeAuthenticationMode,
  version: string,
  authenticationError: Harness.HarnessError | null,
) => {
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
      mode,
      status: authenticated ? "available" : "unavailable",
      diagnostic: authenticationError?.message ?? authenticationProfiles[mode].availableDiagnostic,
    },
    diagnostics,
  } satisfies Harness.HarnessReadiness;
};

const readVersion = (sandbox: SandboxHandle, executable: string) =>
  successfulCommandOutput(sandbox, executable, "--version", installationExitError);

const probeHostAuthentication = (sandbox: SandboxHandle, executable: string) =>
  successfulCommand(sandbox, executable, "auth status --json", authenticationExitError).pipe(
    Effect.map(() => null),
    Effect.catch((error) => Effect.succeed(setupGuidance("host", error))),
  );

const byokCredentialError = (error: CredentialStore.CredentialError) =>
  setupGuidance("byok", harnessError("credential", false, error.message));

const probeByokAuthentication = Effect.fn("ClaudeCode.probeByokAuthentication")(function* () {
  const credentials = yield* CredentialStore.CredentialStore;
  return yield* credentials.providerKey(anthropicProviderAccount).pipe(
    Effect.map(() => null),
    Effect.catch((error) => Effect.succeed(byokCredentialError(error))),
  );
});

const probeAuthentication = (mode: ClaudeAuthenticationMode, sandbox: SandboxHandle, executable: string) =>
  mode === "host" ? probeHostAuthentication(sandbox, executable) : probeByokAuthentication();

const probeReadiness = Effect.fn("ClaudeCode.readiness")(
  (executable: string, mode: ClaudeAuthenticationMode) =>
    withProbeSandbox((sandbox) =>
      Effect.gen(function* () {
        const version = yield* readVersion(sandbox, executable);
        const authenticationError = yield* probeAuthentication(mode, sandbox, executable);
        return { version, authenticationError };
      }),
    ).pipe(Effect.mapError((error) => setupGuidance(mode, error))),
);

const claudeReadiness = Effect.fn("ClaudeCode.readinessResult")(
  (executable: string, mode: ClaudeAuthenticationMode) =>
    probeReadiness(executable, mode).pipe(
      Effect.match({
        onFailure: (error) => readinessFromFailure(mode, error),
        onSuccess: ({ version, authenticationError }) =>
          readinessFromVersion(mode, version, authenticationError),
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
      } satisfies Harness.HarnessCatalogSourceResult;
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

const turnDiagnostics = (mode: ClaudeAuthenticationMode, cause: unknown) => {
  if (isHarnessError(cause)) return cause;
  const message = HarnessBridge.messageFromUnknown(cause);
  if (isMissingExecutableCause(cause)) return setupGuidance(mode, missingHarnessError(message));
  if (authenticationProfiles[mode].failurePattern.test(message)) {
    return setupGuidance(mode, harnessError("credential", false, message));
  }
  return harnessError("turn", true, message);
};

const mcpServerEntry = (server: Harness.ResolvedMcpSkill) => {
  const environmentName = ExternalHarnessRuntime.mcpBearerEnvironmentName(server.name);
  return [
    server.name,
    {
      type: "http",
      url: server.endpoint,
      ...(server.bearer === null ? {} : { headers: { Authorization: `Bearer \${${environmentName}}` } }),
    },
  ] as const;
};

const inlineMcpConfig = (servers: ReadonlyArray<Harness.ResolvedMcpSkill>) => {
  if (servers.length === 0) return "";
  return JSON.stringify({ mcpServers: Object.fromEntries(servers.map(mcpServerEntry)) }).replaceAll(
    " ",
    "\\u0020",
  );
};

const nativeSandboxSettings = (policy: Harness.OperationPolicyProfile) =>
  JSON.stringify({
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: policy === "full",
    },
  });

const claudeExecutableFor = (
  executable: string,
  request: ExternalHarnessRuntime.ExternalHarnessResolvedRequest,
) => {
  const mcpConfig = inlineMcpConfig(request.mcp);
  return [
    executable,
    "--settings",
    inlineSettingsArgument(nativeSandboxSettings(request.policy)),
    ...(mcpConfig ? ["--mcp-config", mcpConfig] : []),
  ].join(" ");
};

const disallowedToolsFor = (policy: Harness.OperationPolicyProfile) => [
  ...(policy === "read-only" ? ["Bash"] : []),
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
];

const adapterConfig = (
  executable: string,
  request: ExternalHarnessRuntime.ExternalHarnessResolvedRequest,
) => {
  return {
    authMode: nativeAuthenticationMode,
    settingSources: [],
    emitDiff: true,
    // "." instead of the adapter's virtual `/workspace` default: the Sandbox
    // remaps `/workspace` for fs and process cwd but not inside command
    // strings, so the post-run `git -C <cwd> diff` only sees the prepared
    // checkout when cwd already resolves there.
    cwd: ".",
    claudeExecutable: claudeExecutableFor(executable, request),
    disallowedTools: disallowedToolsFor(request.policy),
    ...(request.checkout.gitWritablePaths.length > 0
      ? { addDirs: [...request.checkout.gitWritablePaths] }
      : {}),
  } satisfies ClaudeCodeTextConfig;
};

const providerOptions = (request: ExternalHarnessRuntime.ExternalHarnessResolvedRequest) =>
  ({
    authMode: nativeAuthenticationMode,
    ...(request.identity.resumeHandle ? { sessionId: request.identity.resumeHandle } : {}),
  }) satisfies ClaudeCodeTextProviderOptions;

const descriptor = (
  options: ClaudeCodeRunnerOptions,
): ExternalHarnessRuntime.ExternalHarnessDescriptor<ClaudeCodeTextAdapter<ClaudeCodeModel>> => {
  const executable = options.claudeExecutable ?? "claude";
  return {
    name: options.name,
    capabilities: {
      execution: Harness.fullHarnessExecution,
      profile: {
        authenticationModes: claudeAuthenticationModes,
        session: { affinity: "sandbox-lineage", fork: true, humanAttach: false },
        structuredOutput: "native",
        policyFidelity: "profile-only",
        fileEventFidelity: "terminal-only",
        usageQuality: "metered",
        readinessDiagnostics: true,
        journal: true,
        takeover: true,
      },
    },
    authentication: authenticationProfiles[options.authentication.mode].binding,
    signIn: authenticationProfiles[options.authentication.mode].signIn,
    catalogSources: claudeCodeCatalogSources(executable),
    readiness: () => claudeReadiness(executable, options.authentication.mode),
    sharedGit: "required",
    inheritedEnvironment,
    makeAdapter: ({ model, request }) => claudeCodeText(model, adapterConfig(executable, request)),
    projectModel: (request) => request.selection.model ?? "sonnet",
    projectOptions: providerOptions,
    transport: { instructionProjection: "system-prompt", mcpProjection: "native" },
    diagnostics: (cause) => turnDiagnostics(options.authentication.mode, cause),
  };
};

const resolvedAuthentication = Effect.fn("ClaudeCode.resolveAuthentication")(function* (
  mode: ClaudeAuthenticationMode,
) {
  if (mode === "host") {
    return {
      mode,
      secrets: createSecrets({}),
    } satisfies ExternalHarnessRuntime.ExternalHarnessAuthentication;
  }
  const credentials = yield* CredentialStore.CredentialStore;
  const credential = yield* credentials
    .providerKey(anthropicProviderAccount)
    .pipe(Effect.mapError(byokCredentialError));
  return {
    mode,
    secrets: createSecrets({ [anthropicApiKeyEnvironment]: Redacted.value(credential.key) }),
  } satisfies ExternalHarnessRuntime.ExternalHarnessAuthentication;
});

export const claudeCodeRunner = (options: ClaudeCodeRunnerOptions) => {
  return ExternalHarnessRuntime.externalHarnessRunner(descriptor(options), {
    authentication: () => resolvedAuthentication(options.authentication.mode),
  });
};
