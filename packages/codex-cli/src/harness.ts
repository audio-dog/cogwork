import type { HarnessName } from "@cogwork/contracts";
import {
  ExternalHarnessRuntime,
  ExternalHarnessSandbox,
  ExternalHarnessWorkspace,
  Harness,
  HarnessBridge,
  Provider,
  SubagentRunner,
} from "@cogwork/engine";
import {
  type CodexTextAdapter,
  type CodexTextConfig,
  type CodexTextProviderOptions,
  codexText,
} from "@tanstack/ai-codex";
import { BRIDGED_MCP_SERVER_NAME, type SandboxHandle } from "@tanstack/ai-sandbox";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import { codexModelLevels, codexNativeEffort } from "./model";
import { type CodexModel, codexCatalog, codexModels, defaultCodexModel } from "./models.generated";

export type MakeCodexAdapter = (model: CodexModel, config: CodexTextConfig) => CodexTextAdapter<CodexModel>;

export interface CodexRunnerOptions {
  readonly name: HarnessName;
  readonly codexExecutable?: string;
  readonly makeAdapter?: MakeCodexAdapter;
}

const codexVersionRequirement = ">=0.149.0";
const minimumCodexVersion = [0, 149, 0] as const;
const codexReadinessDeadline = "5 seconds";
const codexHookWrapper = `sub=$1
shift
if [ "$sub" = exec ]; then
  exec codex "$sub" --dangerously-bypass-hook-trust "$@"
fi
exec codex "$sub" "$@"`;
export const codexExecutableWithRepositoryHooks = `sh -c '${codexHookWrapper.replaceAll("'", `'\\''`)}' codex-with-repository-hooks`;
const missingExecutablePattern = /ENOENT|EACCES|command not found/i;
const missingLoginPattern = /codex login|not (?:logged|signed) in/i;
const incompatibleVersionPattern = /incompatible|unsupported Codex|update Codex/i;
const missingExecutableCodes = new Set(["ENOENT", "EACCES"]);
const missingExecutableExitCodes = new Set([126, 127]);

const harnessError = (reason: Harness.HarnessError["reason"], retryable: boolean, message: string) =>
  new Harness.HarnessError({ reason, retryable, message });

const missingHarnessError = (message = "Codex CLI is not installed or executable") =>
  harnessError("missing-harness", false, message);

const launchError = (message: string) => harnessError("launch", false, message);
const credentialError = (message: string) => harnessError("credential", false, message);

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

const withMessage = (error: Harness.HarnessError, message: string) =>
  harnessError(error.reason, error.retryable, message);

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

const codexTurnDiagnostics = (cause: unknown) => {
  const message = HarnessBridge.messageFromUnknown(cause);
  if (isMissingExecutableCause(cause)) {
    return addRemediation(missingHarnessError(message));
  }
  if (missingLoginPattern.test(message)) return addRemediation(credentialError(message));
  return harnessError("turn", true, message);
};

const codexLaunchDiagnostics = (cause: unknown) => {
  const diagnostic = codexTurnDiagnostics(cause);
  if (diagnostic.reason !== "turn") return diagnostic;
  const message = diagnostic.message;
  if (incompatibleVersionPattern.test(message)) {
    return harnessError("incompatible-harness", false, message);
  }
  return diagnostic;
};

interface CodexCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const commandFailure = (result: CodexCommandResult, classify: (message: string) => Harness.HarnessError) => {
  if (missingExecutableExitCodes.has(result.exitCode)) return missingHarnessError();
  return classify(`${result.stderr}\n${result.stdout}`);
};

const requireCommandSuccess = (
  result: CodexCommandResult,
  classify: (message: string) => Harness.HarnessError,
) => (result.exitCode === 0 ? Effect.succeed(result) : Effect.fail(commandFailure(result, classify)));

const readinessTimeout = (subject: string) =>
  harnessError(
    "launch",
    true,
    `Codex CLI did not answer its readiness check for ${subject} within ${codexReadinessDeadline}`,
  );

const codexCommand = Effect.fn("CodexRunner.command")(
  (sandbox: SandboxHandle, executable: string, argument: string) =>
    Effect.tryPromise({
      try: (signal) => sandbox.process.exec(`${executable} ${argument}`, { signal }),
      catch: codexLaunchDiagnostics,
    }).pipe(
      Effect.timeout(codexReadinessDeadline),
      Effect.catchTag("TimeoutError", () => readinessTimeout(argument)),
    ),
);

const codexPreflight = Effect.fn("CodexRunner.preflight")((executable: string) =>
  ExternalHarnessSandbox.withLocalProcessSandbox(
    process.cwd(),
    ExternalHarnessRuntime.defaultInheritedEnvironment,
    codexLaunchDiagnostics,
    (sandbox) =>
      Effect.gen(function* () {
        const version = yield* codexCommand(sandbox, executable, "--version").pipe(
          Effect.flatMap((result) => requireCommandSuccess(result, launchError)),
        );
        yield* codexCommand(sandbox, executable, "login status").pipe(
          Effect.flatMap((result) => requireCommandSuccess(result, credentialError)),
        );
        return version.stdout.trim() || version.stderr.trim();
      }),
  ).pipe(Effect.mapError(addRemediation)),
);

const parseCodexVersion = (version: string) => {
  const match = version.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (!match) return null;
  return {
    value: match[0],
    parts: [Number(match[1]), Number(match[2]), Number(match[3])] as const,
  };
};

interface CodexReadinessDiagnosticInput {
  readonly compatible: boolean;
  readonly installedVersion: string | null;
  readonly version: string;
}

const codexReadinessDiagnosticRules = [
  {
    when: ({ compatible }: CodexReadinessDiagnosticInput) => !compatible,
    diagnostic: ({ version }: CodexReadinessDiagnosticInput) =>
      `Codex ${version || "unknown"} is unsupported. Update Codex to ${codexVersionRequirement}.`,
  },
  {
    when: ({ installedVersion }: CodexReadinessDiagnosticInput) =>
      installedVersion !== codexCatalog.generatedAgainst,
    diagnostic: ({ installedVersion }: CodexReadinessDiagnosticInput) =>
      `The model catalog was generated against Codex ${codexCatalog.generatedAgainst}; this Runtime Host has Codex ${installedVersion ?? "unknown"}.`,
  },
] as const;

const codexReadinessDiagnostics = (input: CodexReadinessDiagnosticInput) => {
  return codexReadinessDiagnosticRules
    .filter(({ when }) => when(input))
    .map(({ diagnostic }) => diagnostic(input));
};

const codexReadiness = (executable: string) =>
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
        const installedVersion = parseCodexVersion(version);
        const compatible =
          installedVersion !== null &&
          HarnessBridge.versionAtLeast(installedVersion.parts, minimumCodexVersion);
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
          diagnostics: codexReadinessDiagnostics({
            compatible,
            installedVersion: installedVersion?.value ?? null,
            version,
          }),
        } satisfies Harness.HarnessReadiness;
      },
    }),
  );

const catalogOptions = {
  models: codexCatalog.models,
  generatedAgainst: codexCatalog.generatedAgainst,
  rawModelIds: codexCatalog.rawModelIds,
};

const codexSelectionEffort = (request: ExternalHarnessRuntime.ExternalHarnessResolvedRequest) => {
  const effort = request.selection.options.effort;
  return codexNativeEffort(
    request.selection.model ?? defaultCodexModel,
    typeof effort === "string" ? effort : null,
  );
};

const hostAuthentication = () =>
  Effect.succeed({
    mode: "host",
    secrets: {},
  } satisfies ExternalHarnessRuntime.ExternalHarnessAuthentication);

const tomlString = (value: string) =>
  `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")}"`;

// Codex splits `--config` keys on every ".", with no quoting escape, so a name outside
// this alphabet would silently configure the wrong server. The engine's projected names
// stay inside it; refuse anything else rather than launch misconfigured.
const codexConfigKeySafe = /^[A-Za-z0-9_-]+$/;

interface CodexMcpProjection {
  readonly config: Record<string, string>;
  readonly env: Record<string, string>;
}

// Codex rejects a literal `bearer_token` for streamable-HTTP servers ("set
// `bearer_token_env_var`"), so command arguments carry only the URL and an environment
// variable NAME; the resolved bearer value travels in the child environment alone —
// never in argv and never in a file under the prepared Worktree. Codex prepends
// "Bearer " itself, so the variable holds the raw token.
const codexMcpProjection = (servers: ReadonlyArray<Harness.ResolvedMcpSkill>): CodexMcpProjection => {
  const projected = servers.map((server) => {
    if (!codexConfigKeySafe.test(server.name)) {
      throw new Error(`MCP server name is not a safe Codex config key: ${server.name}`);
    }
    const environmentName = ExternalHarnessWorkspace.mcpBearerEnvironmentName(server.name);
    return {
      config: [
        [`mcp_servers.${server.name}.url`, tomlString(server.endpoint)] as const,
        ...(server.bearer === null
          ? []
          : [[`mcp_servers.${server.name}.bearer_token_env_var`, tomlString(environmentName)] as const]),
      ],
      env: server.bearer === null ? [] : [[environmentName, Redacted.value(server.bearer)] as const],
    };
  });
  return {
    config: Object.fromEntries(projected.flatMap(({ config }) => config)),
    env: Object.fromEntries(projected.flatMap(({ env }) => env)),
  };
};

// Codex ends a bridged MCP tool call at its own `tool_timeout_sec` (60 seconds when unset). An
// engine tool such as `worktree-setup` can run a cold dependency install, so it gets the Run's own
// budget. A Subagent child gets a margin past the engine's child timeout, so the model sees the
// engine's tool error and not a Codex transport error.
const bridgedToolTimeouts = [
  {
    applies: (request: ExternalHarnessRuntime.ExternalHarnessResolvedRequest) => request.tools.length > 0,
    timeout: (request: ExternalHarnessRuntime.ExternalHarnessResolvedRequest) =>
      Duration.fromInputUnsafe(Provider.defaultRunBudget(request.policy)),
  },
  {
    applies: (request: ExternalHarnessRuntime.ExternalHarnessResolvedRequest) => request.subagents.length > 0,
    timeout: () => Duration.sum(SubagentRunner.childTimeout, Duration.minutes(1)),
  },
];

const bridgedToolTimeout = (
  request: ExternalHarnessRuntime.ExternalHarnessResolvedRequest,
): Record<string, string> => {
  const rule = bridgedToolTimeouts.find(({ applies }) => applies(request));
  if (rule === undefined) return {};
  const seconds = Duration.toSeconds(rule.timeout(request));
  return { [`mcp_servers.${BRIDGED_MCP_SERVER_NAME}.tool_timeout_sec`]: String(seconds) };
};

const codexDescriptor = (
  options: CodexRunnerOptions,
): ExternalHarnessRuntime.ExternalHarnessDescriptor<CodexTextAdapter<CodexModel>> => {
  const makeAdapter = options.makeAdapter ?? codexText;
  const executable = options.codexExecutable ?? codexExecutableWithRepositoryHooks;
  return {
    name: options.name,
    capabilities: {
      execution: Harness.fullHarnessExecution,
      profile: {
        authenticationModes: ["host"],
        session: { affinity: "runtime-host", fork: false, humanAttach: "codex-cli" },
        structuredOutput: "native",
        policyFidelity: "none",
        fileEventFidelity: "best-effort",
        usageQuality: "metered",
        readinessDiagnostics: true,
        journal: true,
        takeover: true,
      },
    },
    authentication: { mode: "host", reference: "Codex host login" },
    signIn: "codex login",
    catalog: catalogOptions,
    readiness: () => codexReadiness(executable),
    sharedGit: "required",
    declaredMembers: ["Subagents"],
    modelLevels: codexModelLevels,
    inheritedEnvironment: ExternalHarnessRuntime.defaultInheritedEnvironment,
    makeAdapter: ({ model, nativeAuthentication, request }) => {
      const mcp = codexMcpProjection(request.mcp);
      const config = { ...mcp.config, ...bridgedToolTimeout(request) };
      return makeAdapter(model, {
        authMode: nativeAuthentication,
        approvalPolicy: "never",
        modelReasoningEffort: codexSelectionEffort(request),
        codexExecutable: executable,
        // Codex's `read-only` sandbox mode blocks network too, cutting a read-only
        // Operation off from the Issue tracker it reads with `gh`.
        ...(request.policy === "read-only" ? { sandboxMode: "workspace-write" as const } : {}),
        ...(request.checkout.gitWritablePaths.length > 0
          ? { additionalDirectories: [...request.checkout.gitWritablePaths] }
          : {}),
        ...(Object.keys(config).length > 0 ? { config } : {}),
        ...(Object.keys(mcp.env).length > 0 ? { env: mcp.env } : {}),
      });
    },
    projectModel: (request) =>
      codexModels.find((model) => model === request.selection.model) ?? defaultCodexModel,
    projectOptions: (request) =>
      ({
        ...(request.identity.resumeHandle ? { sessionId: request.identity.resumeHandle } : {}),
        authMode: "host",
      }) satisfies CodexTextProviderOptions,
    transport: {
      instructionProjection: "system-prompt",
      mcpProjection: "native",
      runtimeFileDiffFeed: true,
    },
    diagnostics: codexLaunchDiagnostics,
    turnDiagnostics: codexTurnDiagnostics,
  };
};

export const codexRunner = (options: CodexRunnerOptions): Harness.HarnessRunner => {
  return ExternalHarnessRuntime.externalHarnessRunner(codexDescriptor(options), {
    authentication: hostAuthentication,
  });
};
