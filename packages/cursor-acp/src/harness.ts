import { ndJsonStream, RequestError } from "@agentclientprotocol/sdk";
import { AgUiEvent, type HarnessName, type ModelOptionSelections } from "@cogwork/contracts";
import { ExternalHarnessRuntime, Harness, HarnessBridge } from "@cogwork/engine";
import {
  type AcpCompatibleTextAdapter,
  type AcpHarnessContext,
  type AcpJsonRpcStream,
  type AcpSessionTransport,
  acpCompatible,
  spawnHandleToAcpTransport,
} from "@tanstack/ai-acp";
import { createSecrets } from "@tanstack/ai-sandbox";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import {
  CursorNativeModelIdResult,
  cursorModelFlag,
  cursorNativeModelId,
  parseCursorModelList,
} from "./model";
import { type CursorModel, cursorCatalog, cursorModels } from "./models.generated";

export interface CursorRunnerOptions {
  readonly name: HarnessName;
  readonly agentBin?: string;
}

export type CursorModelOptions = {
  readonly sessionId?: string;
};

const cursorProbeDeadline = "5 seconds";
const missingCursorExecutable = /ENOENT|EACCES|command not found/i;
const cursorVersionRequirement = ">=2026.08.11";
const minimumCursorVersion = [2026, 8, 11] as const;
const inheritedEnvironment = [
  ...ExternalHarnessRuntime.defaultInheritedEnvironment,
  ...ExternalHarnessRuntime.windowsInheritedEnvironment,
  ...ExternalHarnessRuntime.nodeNetworkInheritedEnvironment,
  "CURSOR_CONFIG_DIR",
  "NODE_USE_ENV_PROXY",
  "NO_PROXY",
];

const cursorVersionCompatible = (version: string) => {
  const match = version.match(/\b(\d{4})\.(\d{2})\.(\d{2})\b/);
  if (!match) return false;
  return HarnessBridge.versionAtLeast(
    [Number(match[1]), Number(match[2]), Number(match[3])],
    minimumCursorVersion,
  );
};

const cursorReadinessDiagnostics = (version: string, compatible: boolean) =>
  [
    compatible
      ? null
      : `Cursor ${version || "unknown"} is unsupported. Update Cursor to ${cursorVersionRequirement}.`,
    version === cursorCatalog.generatedAgainst
      ? null
      : `Cursor ${version || "unknown"} differs from the version this catalog was generated against (${cursorCatalog.generatedAgainst}).`,
  ].filter((message) => message !== null);

const cursorProbeError = (cause: unknown) => {
  const message = String(cause);
  return new Harness.HarnessError({
    reason: missingCursorExecutable.test(message) ? "missing-harness" : "launch",
    retryable: false,
    message,
  });
};

const cursorCommand = Effect.fn("CursorRunner.command")((agentBin: string, argument: string) =>
  ExternalHarnessRuntime.withLocalProcessSandbox(
    process.cwd(),
    inheritedEnvironment,
    cursorProbeError,
    (sandbox) =>
      Effect.tryPromise({
        try: (signal) => sandbox.process.exec(`${agentBin} ${argument}`, { signal }),
        catch: cursorProbeError,
      }).pipe(
        Effect.timeout(cursorProbeDeadline),
        Effect.catchTag(
          "TimeoutError",
          () =>
            new Harness.HarnessError({
              reason: "launch",
              retryable: true,
              message: `Cursor did not answer ${argument} within ${cursorProbeDeadline}`,
            }),
        ),
      ),
  ),
);

const cursorCommandFailureReason = (
  argument: string,
  result: { readonly exitCode: number; readonly stderr: string },
): "missing-harness" | "incompatible-harness" | "launch" => {
  if (result.exitCode === 126 || result.exitCode === 127 || missingCursorExecutable.test(result.stderr)) {
    return "missing-harness";
  }
  if (argument === "--list-models") return "incompatible-harness";
  return "launch";
};

const cursorCommandFailure = (
  argument: string,
  result: { readonly exitCode: number; readonly stdout: string; readonly stderr: string },
) =>
  new Harness.HarnessError({
    reason: cursorCommandFailureReason(argument, result),
    retryable: false,
    message: `Cursor ${argument} failed. Update or reinstall Cursor. (${result.stderr || result.stdout})`,
  });

const requireCursorCommand = Effect.fn("CursorRunner.requireCommand")(function* (
  agentBin: string,
  argument: string,
) {
  const result = yield* cursorCommand(agentBin, argument);
  if (result.exitCode !== 0) return yield* cursorCommandFailure(argument, result);
  return result;
});

const cursorRuntimeVersion = Effect.fn("CursorRunner.runtimeVersion")(function* (agentBin: string) {
  const versionResult = yield* requireCursorCommand(agentBin, "--version");
  const modelResult = yield* requireCursorCommand(agentBin, "--list-models");
  const models = parseCursorModelList(modelResult.stdout);
  if (models.length === 0) {
    return yield* new Harness.HarnessError({
      reason: "incompatible-harness",
      retryable: false,
      message: "Cursor returned no model catalog. Update Cursor, then retry.",
    });
  }
  const harnessVersion = versionResult.stdout.trim() || versionResult.stderr.trim();
  return harnessVersion;
});

const unavailableCursorReadiness = (error: Harness.HarnessError) =>
  ({
    operational: { status: "unavailable", retryable: error.retryable, diagnostic: error.message },
    installation: {
      status: error.reason === "missing-harness" ? "missing" : "unknown",
      version: null,
    },
    compatibility: {
      status: error.reason === "incompatible-harness" ? "incompatible" : "unknown",
      requirement: "agent --version and agent --list-models",
    },
    authentication: { mode: "host", status: "unknown", diagnostic: error.message },
    diagnostics: [error.message],
  }) satisfies Harness.HarnessReadiness;

const cursorReadiness = Effect.fn("CursorRunner.readiness")((agentBin: string) =>
  cursorRuntimeVersion(agentBin).pipe(
    Effect.match({
      onFailure: unavailableCursorReadiness,
      onSuccess: (version) => {
        const compatible = cursorVersionCompatible(version);
        return {
          operational: { status: "ready", retryable: false, diagnostic: "Cursor is ready" },
          installation: { status: "installed", version },
          compatibility: {
            status: compatible ? "compatible" : "incompatible",
            requirement: cursorVersionRequirement,
          },
          authentication: {
            mode: "host",
            status: "unknown",
            diagnostic: "Cursor host login is verified by the native launch",
          },
          diagnostics: cursorReadinessDiagnostics(version, compatible),
        } satisfies Harness.HarnessReadiness;
      },
    }),
  ),
);

// Cursor keeps conversation history server-side; the opaque handle is how you resume it.
export const cursorModelOptions = (handle: string | null) => ({
  ...(handle ? { sessionId: handle } : {}),
});

const launchCodes = new Set(["ENOENT", "EACCES"]);

const hasLaunchCode = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof error.code === "string" &&
  launchCodes.has(error.code);

const fromRequestError = (error: RequestError) => {
  if (error.code === -32000) {
    return new Harness.HarnessError({
      reason: "credential",
      retryable: false,
      message: `Cursor authentication is unavailable. Sign in to Cursor, then retry. (${error.message})`,
    });
  }
  return new Harness.HarnessError({
    reason: "turn",
    retryable: error.code === -32603,
    message: error.message,
  });
};

const cursorDiagnostics = (error: unknown) => {
  if (error instanceof RequestError) return fromRequestError(error);
  const message = HarnessBridge.messageFromUnknown(error);
  const launch = hasLaunchCode(error);
  return new Harness.HarnessError({ reason: launch ? "launch" : "turn", retryable: !launch, message });
};

export const estimateTokens = (chars: number) => Math.ceil(chars / 4);

// Cursor's `agent acp` never reports token usage — the ACP prompt response is `{stopReason}`
// with no `usage`, and no session update carries counts (see FINDINGS.md Q2) — so without an
// estimate a completed run records nothing.
export const estimatedUsage = (promptChars: number, outputTextChars: number) => {
  const promptTokens = estimateTokens(promptChars);
  const completionTokens = estimateTokens(outputTextChars);
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    estimated: true,
  };
};

const estimatedEvent = (promptChars: number, outputTextChars: number, event: AgUiEvent) => {
  if (!AgUiEvent.guards.RUN_FINISHED(event) || event.usage) return event;
  return { ...event, usage: estimatedUsage(promptChars, outputTextChars) };
};

type AcpMessage = AcpJsonRpcStream extends { readable: ReadableStream<infer Message> } ? Message : never;
type CursorRunPromise = Effect.Success<ReturnType<typeof FiberSet.makeRuntimePromise<never>>>;

// Cursor's agent sends these vendor JSON-RPC requests to report completed
// tool calls (subagents, todo updates) it already ran in-process, then ignores
// our reply. `@tanstack/ai-acp`'s client has no handler for them, so the ACP SDK
// refuses each with -32601 and logs it. We ack them with an empty result so the
// noise stops without touching the package.
const swallowedCursorMethods = new Set<string>(["cursor/task", "cursor/update_todos"]);

class CursorTransportError extends Data.TaggedError("CursorTransportError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

const transportError = (cause: unknown) =>
  new CursorTransportError({ cause, message: cause instanceof Error ? cause.message : String(cause) });

export const interceptCursorTelemetry = (
  base: AcpJsonRpcStream,
  runPromise: CursorRunPromise,
): AcpJsonRpcStream => {
  const outbound = Semaphore.makeUnsafe(1);
  const withWriter = <A>(use: (writer: WritableStreamDefaultWriter<AcpMessage>) => Promise<A>) =>
    outbound.withPermit(
      Effect.acquireUseRelease(
        Effect.sync(() => base.writable.getWriter()),
        (writer) => Effect.tryPromise({ try: () => use(writer), catch: transportError }),
        (writer) => Effect.sync(() => writer.releaseLock()),
      ),
    );
  const runWithWriter = <A>(use: (writer: WritableStreamDefaultWriter<AcpMessage>) => Promise<A>) =>
    runPromise(withWriter(use));

  return {
    readable: Stream.fromReadableStream({
      evaluate: () => base.readable,
      onError: transportError,
    }).pipe(
      Stream.filterEffect((message) => {
        if (!("method" in message && "id" in message && swallowedCursorMethods.has(message.method))) {
          return Effect.succeed(true);
        }
        return Effect.tryPromise({
          try: () => runWithWriter((writer) => writer.write({ jsonrpc: "2.0", id: message.id, result: {} })),
          catch: transportError,
        }).pipe(
          Effect.ignore,
          Effect.map(() => false),
        );
      }),
      Stream.toReadableStream(),
    ),
    writable: new WritableStream<AcpMessage>({
      write: (message) => runWithWriter((writer) => writer.write(message)),
      close: () => runWithWriter((writer) => writer.close()),
      abort: (reason) => runWithWriter((writer) => writer.abort(reason)),
    }),
  };
};

const openCursorTransport = (agentBin: string) =>
  FiberSet.makeRuntimePromise().pipe(
    Effect.map((runPromise) => (ctx: AcpHarnessContext<CursorModelOptions>): Promise<AcpSessionTransport> => {
      const flag = cursorModelFlag(ctx.model);
      return ctx.sandbox.process
        .spawn(`${agentBin} --model ${flag} acp`, {
          cwd: ctx.cwd,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        })
        .then((handle) => {
          const bytes = spawnHandleToAcpTransport(handle);
          return {
            kind: "stream",
            stream: interceptCursorTelemetry(ndJsonStream(bytes.writable, bytes.readable), runPromise),
            dispose: () => bytes.kill(),
            stderrTail: bytes.stderrTail,
          };
        });
    }),
  );

type CursorOpenTransport = Effect.Success<ReturnType<typeof openCursorTransport>>;

type CursorAdapter = AcpCompatibleTextAdapter<CursorModel, CursorModelOptions>;

const generatedCatalog = {
  models: cursorCatalog.models,
  generatedAgainst: cursorCatalog.generatedAgainst,
  rawModelIds: cursorCatalog.rawModelIds,
  rawModelSelections: cursorCatalog.rawModelSelections,
};
const cursorNativeSelection = (model: string | null, options: ModelOptionSelections) => {
  const defaultModel = cursorCatalog.models.find(({ default: isDefault }) => isDefault)?.value ?? "auto";
  return cursorNativeModelId(cursorCatalog, model ?? defaultModel, options);
};

const CursorModelSchema = Schema.Literals(cursorModels);
const staleSelection = (message: string) =>
  new Harness.HarnessError({
    reason: "stale-selection",
    retryable: false,
    message,
  });

const resolveCursorModel = (input: Harness.HarnessPreflightInput) => {
  const selection = Harness.selectionOfPreflightInput(input);
  const translated = cursorNativeSelection(selection.model, selection.options);
  return CursorNativeModelIdResult.$match(translated, {
    Failure: ({ error }) => Effect.fail(staleSelection(error)),
    Success: ({ value }) =>
      Schema.decodeUnknownEffect(CursorModelSchema)(value).pipe(
        Effect.mapError(() => staleSelection(`Cursor catalog does not include native model ${value}`)),
      ),
  });
};

const promptCharacters = (request: ExternalHarnessRuntime.ExternalHarnessResolvedRequest) =>
  request.prompt.reduce((total, message) => total + message.content.length, 0);

const cursorUsage: ExternalHarnessRuntime.ExternalHarnessUsageEstimator = (request, event, outputTextChars) =>
  estimatedEvent(promptCharacters(request), outputTextChars, event);

const hostAuthentication = () =>
  Effect.succeed({
    mode: "host",
    secrets: createSecrets({}),
  } satisfies ExternalHarnessRuntime.ExternalHarnessAuthentication);

export const cursorRunner = (options: CursorRunnerOptions): Harness.HarnessRunner => {
  const agentBin = options.agentBin ?? "agent";
  const capabilities = {
    execution: {
      nonInteractive: true,
      worktreeConfined: false,
      profiles: ["full"],
    },
    profile: {
      authenticationModes: ["host"],
      session: { affinity: "runtime-host", fork: false, humanAttach: false },
      structuredOutput: "prompt-and-parse",
      policyFidelity: "none",
      fileEventFidelity: "absent",
      usageQuality: "estimated",
      readinessDiagnostics: true,
      journal: false,
      takeover: false,
    },
  } satisfies ExternalHarnessRuntime.ExternalHarnessCapabilities;
  const authentication: Harness.HarnessRunner["authentication"] = {
    mode: "host",
    reference: "Cursor host login",
  };
  const readiness = () => cursorReadiness(agentBin);
  const makeRunner = (openTransport: CursorOpenTransport, model: CursorModel) => {
    const descriptor: ExternalHarnessRuntime.ExternalHarnessDescriptor<CursorAdapter> = {
      name: options.name,
      capabilities,
      authentication,
      catalog: generatedCatalog,
      readiness,
      sharedGit: "none",
      inheritedEnvironment,
      makeAdapter: ({ model }) =>
        acpCompatible<typeof cursorModels, CursorModelOptions>({
          name: options.name,
          models: cursorModels,
          modelOptions: {},
          openTransport,
          planEventName: `${options.name}.plan`,
          authMode: "host",
          permissionMode: "default",
          permissions: "headless",
        })(model),
      projectModel: () => model,
      projectOptions: (request) => cursorModelOptions(request.identity.resumeHandle),
      transport: { instructionProjection: "system-prompt" },
      diagnostics: cursorDiagnostics,
      estimateUsage: cursorUsage,
    };
    return ExternalHarnessRuntime.externalHarnessRunner(descriptor, {
      authentication: hostAuthentication,
    });
  };
  return {
    name: options.name,
    ...ExternalHarnessRuntime.externalHarnessDeclaration,
    execution: capabilities.execution,
    capabilities: capabilities.profile,
    authentication,
    catalog: generatedCatalog,
    readiness,
    validateLaunch: (request) =>
      Harness.validateCheckoutDirectory(options.name, request.plan.sandbox.workspace).pipe(Effect.asVoid),
    preflight: (input) =>
      resolveCursorModel(input).pipe(
        Effect.flatMap((model) =>
          Effect.scoped(
            openCursorTransport(agentBin).pipe(
              Effect.flatMap((openTransport) => makeRunner(openTransport, model).preflight(input)),
            ),
          ),
        ),
      ),
    run: (request) =>
      Stream.unwrap(
        resolveCursorModel(Harness.HarnessPreflightInput.Launch({ request })).pipe(
          Effect.flatMap((model) =>
            openCursorTransport(agentBin).pipe(
              Effect.map((openTransport) => makeRunner(openTransport, model).run(request)),
            ),
          ),
        ),
      ),
  };
};
