import type { HarnessName } from "@cogwork/contracts";
import { ExternalHarnessRuntime, Harness, HarnessBridge, Tools } from "@cogwork/engine";
import type { ChatMiddleware, ChatMiddlewareContext } from "@tanstack/ai";
import {
  CODEX_MODELS,
  type CodexAuthMode,
  type CodexModel,
  type CodexTextAdapter,
  type CodexTextConfig,
  type CodexTextProviderOptions,
  codexText,
} from "@tanstack/ai-codex";
import { getSandbox, type SandboxHandle, type SandboxHooks } from "@tanstack/ai-sandbox";
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process";
import * as Effect from "effect/Effect";

export type CodexEffort = NonNullable<CodexTextProviderOptions["modelReasoningEffort"]>;

export type MakeCodexAdapter = (model: CodexModel, config: CodexTextConfig) => CodexTextAdapter<CodexModel>;

export interface CodexRunnerOptions {
  readonly name: HarnessName;
  readonly environment: NodeJS.ProcessEnv;
  readonly codexExecutable?: string;
  readonly fileHooks?: SandboxHooks;
  readonly makeAdapter?: MakeCodexAdapter;
}

const codexEfforts = ["minimal", "low", "medium", "high"] as const satisfies ReadonlyArray<CodexEffort>;
const defaultCodexModel = CODEX_MODELS[0];
const defaultCodexEffort = "high" satisfies CodexEffort;
const codexAdapterVersion = "0.5.3";
const codexVersionRequirement = ">=0.149.0";
const minimumCodexVersion = [0, 149, 0] as const;
const codexReadinessDeadline = "5 seconds";
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

const createReadinessSandbox = Effect.fn("CodexRunner.createReadinessSandbox")(
  (scrubEnv: ReadonlyArray<string>) =>
    Effect.tryPromise({
      try: () => localProcessSandbox({ dir: process.cwd(), scrubEnv: [...scrubEnv] }).create({}),
      catch: codexLaunchDiagnostics,
    }).pipe(
      Effect.timeout(codexReadinessDeadline),
      Effect.catchTag("TimeoutError", () => readinessTimeout("sandbox creation")),
    ),
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

const codexPreflight = Effect.fn("CodexRunner.preflight")(
  (executable: string, scrubEnv: ReadonlyArray<string>) =>
    Effect.scoped(
      Effect.acquireRelease(createReadinessSandbox(scrubEnv), (sandbox) =>
        Effect.promise(() => sandbox.destroy()),
      ).pipe(
        Effect.flatMap((sandbox) =>
          Effect.gen(function* () {
            const version = yield* codexCommand(sandbox, executable, "--version").pipe(
              Effect.flatMap((result) => requireCommandSuccess(result, launchError)),
            );
            yield* codexCommand(sandbox, executable, "login status").pipe(
              Effect.flatMap((result) => requireCommandSuccess(result, credentialError)),
            );
            return version.stdout.trim() || version.stderr.trim();
          }),
        ),
      ),
    ).pipe(Effect.mapError(addRemediation)),
);

const versionAtLeast = (actual: ReadonlyArray<number>, minimum: ReadonlyArray<number>) =>
  (actual.map((part, index) => Math.sign(part - (minimum[index] ?? 0))).find((part) => part !== 0) ?? 0) >= 0;

const codexVersionCompatible = (version: string) => {
  const match = version.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (!match) return false;
  return versionAtLeast([Number(match[1]), Number(match[2]), Number(match[3])], minimumCodexVersion);
};

const codexReadiness = (executable: string, scrubEnv: ReadonlyArray<string>) =>
  codexPreflight(executable, scrubEnv).pipe(
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
  );

const selectedEffort = (effort: string | null) => {
  const selected = effort ?? defaultCodexEffort;
  const supported = codexEfforts.find((candidate) => candidate === selected);
  if (supported) return supported;
  throw new Error(`unsupported Codex reasoning effort: ${selected}`);
};

const catalogOptions = {
  models: CODEX_MODELS.map((model) => ({ value: model, label: model })),
  efforts: codexEfforts.map((effort) => ({ value: effort, label: effort })),
};

const inheritedCodexEnvironment = new Set([
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
]);

const scrubbedEnvironment = (environment: NodeJS.ProcessEnv) =>
  Object.keys(environment).filter((name) => !inheritedCodexEnvironment.has(name));

const hostAuthentication = () =>
  Effect.succeed({
    mode: "host",
    secrets: {},
  } satisfies ExternalHarnessRuntime.ExternalHarnessAuthentication);

const removeCodexMcpConfig = (context: ChatMiddlewareContext) =>
  getSandbox(context, { optional: true })?.fs.remove(".codex/config.toml") ?? Promise.resolve();

const transientCodexConfig: ChatMiddleware = {
  name: "codex-transient-config",
  onFinish: removeCodexMcpConfig,
  onAbort: removeCodexMcpConfig,
  onError: removeCodexMcpConfig,
};

const codexDescriptor = (
  options: CodexRunnerOptions,
): ExternalHarnessRuntime.ExternalHarnessDescriptor<CodexTextAdapter<CodexModel>, CodexAuthMode> => {
  const makeAdapter = options.makeAdapter ?? codexText;
  const executable = options.codexExecutable ?? "codex";
  const scrubEnv = scrubbedEnvironment(options.environment);
  return {
    name: options.name,
    sessionKind: "opaque-handle",
    capabilities: {
      execution: Harness.fullHarnessExecution,
      profile: {
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
    authentication: { mode: "host", reference: "Codex host login" },
    catalogSources: {
      runtime: Harness.staticCatalogSource(catalogOptions, {
        source: "tanstack-runtime",
        packageVersion: codexAdapterVersion,
      }),
      fallback: Harness.staticCatalogSource(catalogOptions, {
        source: "cogwork-fallback",
        fallbackVersion: `codex-${codexAdapterVersion}`,
      }),
    },
    readiness: () => codexReadiness(executable, scrubEnv),
    sharedGit: "required",
    makeAdapter: ({ model, authentication, request }) =>
      makeAdapter(model, {
        authMode: authentication,
        approvalPolicy: "never",
        codexExecutable: executable,
        ...(request.checkout.sharedGitDirectory
          ? { additionalDirectories: [request.checkout.sharedGitDirectory] }
          : {}),
      }),
    projectModel: (request) => request.selection.model ?? defaultCodexModel,
    projectOptions: (request) => ({
      ...(request.identity.resumeHandle ? { sessionId: request.identity.resumeHandle } : {}),
      modelReasoningEffort: selectedEffort(request.selection.effort),
      authMode: "host",
    }),
    projectAuthentication: () => "host",
    transport: {
      workspaceRoot: ".",
      middleware: () => [transientCodexConfig],
    },
    diagnostics: codexLaunchDiagnostics,
    turnDiagnostics: codexTurnDiagnostics,
  };
};

export const codexRunner = (options: CodexRunnerOptions): Harness.HarnessRunner => {
  const scrubEnv = scrubbedEnvironment(options.environment);
  return ExternalHarnessRuntime.externalHarnessRunner(codexDescriptor(options), {
    authentication: hostAuthentication,
    sandboxProvider: ExternalHarnessRuntime.trustedLocalProcessSandboxProvider({ scrubEnv }),
    sandboxPolicy: (request) => Effect.succeed(Tools.policyForProfile(request.policy)),
    ...(options.fileHooks ? { fileHooks: options.fileHooks } : {}),
  });
};
