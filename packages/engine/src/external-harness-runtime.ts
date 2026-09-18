import { createHash } from "node:crypto";
import {
  AgUiEvent,
  agUiIsFileDiffEvent,
  FILE_DIFF_EVENT,
  type HarnessName,
  type RunId,
  type RunPlanInstruction,
  type RunPlanMessage,
  type RunPlanOperatingInstructions,
  type SessionId,
} from "@cogwork/contracts";
import {
  type AnyTextAdapter,
  type ChatMiddleware,
  chat,
  type JSONSchema,
  RUN_CANCEL_REASON,
} from "@tanstack/ai";
import { scrubSecrets } from "@tanstack/ai/byok";
import {
  bearer,
  createSecrets,
  DEFAULT_WORKSPACE_ROOT,
  defineSandbox,
  defineWorkspace,
  mcpSkill,
  ProjectionCapability,
  provideWorkspaceProjection,
  resolveAllSecrets,
  type SandboxHandle,
  type SandboxProvider,
  type Secrets,
  type WorkspaceDefinition,
  withSandbox,
} from "@tanstack/ai-sandbox";
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  type HarnessAuthenticationBinding,
  type HarnessAuthenticationMode,
  type HarnessCapabilityProfile,
  type HarnessCatalogSources,
  HarnessError,
  type HarnessExecution,
  HarnessPreflightInput,
  type HarnessReadiness,
  type HarnessRequest,
  type HarnessRunner,
  type HarnessRunnerEnv,
  type OperationPolicyProfile,
  type ResolvedMcpSkill,
  resolvedMcpSkills,
  validateCheckoutDirectory,
} from "./harness";
import { bridgeChat } from "./provider-bridge";
import { SessionStore } from "./session-store";
import { boundedDiff, ignored, mergeFileDiffFeed, watchWorktreeDiffs } from "./tools/file-diff-feed";
import { policyForProfile } from "./tools/policy";
import { openWorktreeSandbox, resolveBaseSha } from "./tools/sandbox";

type AdapterModel<Adapter extends AnyTextAdapter> = Adapter["model"];
type AdapterOptions<Adapter extends AnyTextAdapter> = Adapter["~types"]["providerOptions"];

export interface ExternalHarnessAuthentication {
  readonly mode: HarnessAuthenticationMode;
  readonly secrets: Secrets;
}

export interface ExternalHarnessIdentity {
  readonly run: RunId;
  readonly session: SessionId;
  readonly resumeHandle: string | null;
}

export interface ExternalHarnessSelection {
  readonly model: string | null;
  readonly effort: string | null;
}

export interface ExternalHarnessCheckout {
  readonly path: string;
  readonly gitWritablePaths: ReadonlyArray<string>;
}

export interface ExternalHarnessSecrets {
  readonly mcp: ReadonlyMap<string, Redacted.Redacted<string>>;
}

export interface ExternalHarnessResolvedRequest {
  readonly identity: ExternalHarnessIdentity;
  readonly selection: ExternalHarnessSelection;
  readonly authentication: ExternalHarnessAuthentication;
  readonly policy: OperationPolicyProfile;
  readonly instructions: ReadonlyArray<RunPlanInstruction>;
  readonly operatingInstructions: RunPlanOperatingInstructions;
  readonly mcp: ReadonlyArray<ResolvedMcpSkill>;
  readonly secrets: ExternalHarnessSecrets;
  readonly checkout: ExternalHarnessCheckout;
  readonly prompt: ReadonlyArray<RunPlanMessage>;
  readonly outputSchema: JSONSchema | null;
}

export interface ExternalHarnessCapabilities {
  readonly execution: HarnessExecution;
  readonly profile: HarnessCapabilityProfile;
}

export interface ExternalHarnessTransport {
  readonly instructionProjection?: "workspace" | "system-prompt";
  /**
   * `"native"` promises the descriptor delivers `request.mcp` itself through its
   * adapter's own transport (Codex: documented `config`/`env` passthrough), so the
   * runtime keeps MCP servers and their secrets out of the Harness Workspace.
   */
  readonly mcpProjection?: "workspace" | "native";
  /**
   * Whether the runtime supplies this descriptor's File-diff feed from the checkout.
   * A transport fact, never read off the capability profile: a more honest profile
   * label must not switch the feed off.
   */
  readonly runtimeFileDiffFeed?: boolean;
}

export type ExternalHarnessUsageEstimator = (
  request: ExternalHarnessResolvedRequest,
  event: AgUiEvent,
  outputTextCharacters: number,
) => AgUiEvent;

export interface ExternalHarnessDescriptor<Adapter extends AnyTextAdapter> {
  readonly name: HarnessName;
  readonly capabilities: ExternalHarnessCapabilities;
  readonly authentication: HarnessAuthenticationBinding;
  readonly signIn?: string;
  readonly catalogSources: HarnessCatalogSources;
  readonly readiness: () => Effect.Effect<HarnessReadiness, never, HarnessRunnerEnv>;
  readonly sharedGit: "none" | "required";
  readonly inheritedEnvironment: ReadonlyArray<string>;
  readonly makeAdapter: (input: {
    readonly model: AdapterModel<Adapter>;
    readonly nativeAuthentication: "host";
    readonly request: ExternalHarnessResolvedRequest;
  }) => Adapter;
  readonly projectModel: (request: ExternalHarnessResolvedRequest) => AdapterModel<Adapter>;
  readonly projectOptions: (request: ExternalHarnessResolvedRequest) => AdapterOptions<Adapter>;
  readonly transport: ExternalHarnessTransport;
  readonly diagnostics: (cause: unknown) => HarnessError;
  readonly turnDiagnostics?: (cause: unknown) => HarnessError;
  readonly estimateUsage?: ExternalHarnessUsageEstimator;
}

type ExternalInputEffect<Value> = Effect.Effect<Value, HarnessError, HarnessRunnerEnv>;

export interface ExternalHarnessRuntimeInputs {
  readonly authentication: (request: HarnessRequest) => ExternalInputEffect<ExternalHarnessAuthentication>;
}

export const defaultInheritedEnvironment = Object.freeze([
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

export const windowsInheritedEnvironment = Object.freeze([
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "SYSTEMROOT",
  "PATHEXT",
  "COMSPEC",
]);

export const externalHarnessDeclaration = Object.freeze({
  sessionKind: "opaque-handle",
  projectedMembers: Object.freeze([
    "Harness Adapter",
    "Instructions",
    "Messages",
    "MCP",
    "Middleware",
    "Sandbox",
    "Structured Output",
    "Persistence",
    "Connections",
  ]),
  planMiddleware: Object.freeze(["sandbox"]),
} satisfies Pick<HarnessRunner, "sessionKind" | "projectedMembers" | "planMiddleware">);

const preparedWorkspace = { source: { type: "none" } } satisfies WorkspaceDefinition;

const authenticationMismatch = (
  name: HarnessName,
  expected: HarnessAuthenticationMode,
  actual: ExternalHarnessAuthentication,
) =>
  new HarnessError({
    reason: "credential",
    retryable: false,
    message: `harness runner ${name} requires ${expected} authentication, received ${actual.mode}`,
  });

// Hex-hashed so the name is a valid environment identifier for any projected server name,
// and so a rotated credential never changes the name the harness is configured with. Shared
// with native MCP projection (the Codex descriptor), whose config references this name.
export const mcpBearerEnvironmentName = (server: string) =>
  `COGWORK_MCP_${createHash("sha256").update(server).digest("hex").toUpperCase()}_BEARER`;

const workspaceInstructions = (request: ExternalHarnessResolvedRequest) =>
  [
    ...request.instructions.map(({ content }) => content),
    `Mandatory Operating Instructions: ${request.operatingInstructions.path}`,
  ].join("\n\n");

const mcpSkillConfig = (secrets: Secrets, server: ResolvedMcpSkill) => {
  const secret = server.bearer === null ? undefined : secrets[mcpBearerEnvironmentName(server.name)];
  if (!secret) return { url: server.endpoint };
  return { url: server.endpoint, headers: { Authorization: bearer(secret) } };
};

const mcpSecretEntry = ({ name, bearer: secret }: ResolvedMcpSkill) => {
  if (secret === null) return [];
  return [[mcpBearerEnvironmentName(name), Redacted.value(secret)] satisfies readonly [string, string]];
};

const mcpWorkspaceProjection = (request: ExternalHarnessResolvedRequest) => {
  const secretValues = Object.fromEntries(request.mcp.flatMap(mcpSecretEntry));
  const secrets = createSecrets(secretValues);
  const skills = request.mcp.map((server) => mcpSkill(server.name, mcpSkillConfig(secrets, server)));
  return { secretValues, skills };
};

const resolvedSecretValues = (secrets: Secrets) =>
  Object.keys(secrets).length === 0 ? {} : resolveAllSecrets(secrets);

const harnessWorkspace = <Adapter extends AnyTextAdapter>(
  descriptor: ExternalHarnessDescriptor<Adapter>,
  request: ExternalHarnessResolvedRequest,
) => {
  const mcp = mcpWorkspaceProjection(request);
  const secretValues = {
    ...resolvedSecretValues(request.authentication.secrets),
    ...mcp.secretValues,
  };
  return {
    ...preparedWorkspace,
    ...(descriptor.transport.instructionProjection === "system-prompt"
      ? {}
      : { instructions: workspaceInstructions(request) }),
    ...(descriptor.transport.mcpProjection !== "native" && mcp.skills.length > 0
      ? { skills: mcp.skills }
      : {}),
    ...(Object.keys(secretValues).length > 0 ? { secrets: createSecrets(secretValues) } : {}),
  } satisfies WorkspaceDefinition;
};

const writesWorkspaceFiles = (definition: WorkspaceDefinition) =>
  definition.instructions !== undefined || definition.skills !== undefined;

const workspaceSecretValues = (definition: WorkspaceDefinition) =>
  definition.secrets ? Object.values(resolveAllSecrets(definition.secrets)) : [];

const eventMetadataFields = new Set([
  "type",
  "threadId",
  "runId",
  "messageId",
  "toolCallId",
  "name",
  "toolCallName",
  "stepName",
  "finishReason",
  "role",
]);

const scrubValue = (value: unknown, secrets: ReadonlyArray<string>): unknown => {
  if (typeof value === "string") return scrubSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((entry) => scrubValue(entry, secrets));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, scrubValue(entry, secrets)]));
};

const scrubEvent = (event: AgUiEvent, secrets: ReadonlyArray<string>) => {
  if (secrets.length === 0) return event;
  const scrubbed = Object.fromEntries(
    Object.entries(event).map(([key, value]) => [
      key,
      eventMetadataFields.has(key) ? value : scrubValue(value, secrets),
    ]),
  );
  return Schema.decodeUnknownSync(AgUiEvent)(scrubbed);
};

const scrubHarnessError = (error: HarnessError, secrets: ReadonlyArray<string>) =>
  secrets.length === 0
    ? error
    : new HarnessError({
        reason: error.reason,
        retryable: error.retryable,
        message: scrubSecrets(error.message, secrets),
      });

// `withSandbox` always hands the adapter a Workspace projection, and every adapter's
// projection pass then writes a one-time marker file into the checkout — a file the agent
// can commit from a prepared Worktree. When the Workspace has no members to project,
// re-provide the projection (capability provides are last-wins by contract) with the
// marker gate already satisfied: `.git` exists in every prepared checkout, so the
// adapter's pass returns before touching the Worktree.
const satisfiedProjection = (): ChatMiddleware => ({
  name: "cogwork-workspace-already-projected",
  provides: [ProjectionCapability],
  setup: (context) => {
    // The duplicate-provide warning exists to catch accidental overwrites; this overwrite
    // is the point, and the warning would otherwise land in the daemon log on every such
    // launch. This middleware is the last provider in the chain, so muting loses nothing.
    context.capabilities.setOnDuplicate(() => {});
    provideWorkspaceProjection(context, {
      skills: [],
      plugins: [],
      resolveSecret: () => {
        throw new Error("this run projects no Workspace members, so no secret can be resolved");
      },
      markerPath: `${DEFAULT_WORKSPACE_ROOT}/.git`,
      root: DEFAULT_WORKSPACE_ROOT,
    });
  },
});

const validateMcpCredentials = Effect.fn("ExternalHarnessRuntime.validateMcpCredentials")(function* (
  request: HarnessRequest,
) {
  const missingCredentials = request.plan.mcp.flatMap((server) =>
    "endpoint" in server && server.authenticated && !request.mcpCredentials.has(server.identity)
      ? [server.projectedName]
      : [],
  );
  if (missingCredentials.length > 0) {
    return yield* new HarnessError({
      reason: "credential",
      retryable: false,
      message: `authenticated MCP servers have no live credential: ${missingCredentials.join(", ")}`,
    });
  }
});

const validateExternalRequest = Effect.fn("ExternalHarnessRuntime.validateRequest")(function* <
  Adapter extends AnyTextAdapter,
>(
  descriptor: ExternalHarnessDescriptor<Adapter>,
  request: HarnessRequest,
  resolved: ExternalHarnessResolvedRequest,
) {
  if (request.plan.sandbox.policy !== request.plan.harness.profile) {
    return yield* new HarnessError({
      reason: "policy",
      retryable: false,
      message: `harness runner ${descriptor.name} Sandbox policy does not match its immutable Harness profile`,
    });
  }
  if (!request.plan.middleware.includes("sandbox")) {
    return yield* new HarnessError({
      reason: "sandbox",
      retryable: false,
      message: `harness runner ${descriptor.name} Run Plan is missing mandatory Sandbox projection`,
    });
  }
  const authentication = resolved.authentication;
  if (authentication.mode !== descriptor.authentication.mode) {
    return yield* authenticationMismatch(descriptor.name, descriptor.authentication.mode, authentication);
  }
  yield* validateMcpCredentials(request);
});

const resolveResumeHandle = Effect.fn("ExternalHarnessRuntime.resolveResumeHandle")(function* (
  session: SessionId,
) {
  const store = yield* SessionStore;
  return yield* store.resumeHandle(session);
});

const requireSession = Effect.fn("ExternalHarnessRuntime.requireSession")(function* (
  session: SessionId | null,
) {
  if (session) return session;
  return yield* new HarnessError({
    reason: "launch",
    retryable: false,
    message: "external Harness launch requires a Cogwork Session",
  });
});

const sharedGitError = (checkoutPath: string) =>
  new HarnessError({
    reason: "workspace",
    retryable: false,
    message: `shared Git metadata is unavailable for prepared checkout ${checkoutPath}`,
  });

// A linked Worktree reaches these through the common directory, and the common directory itself is
// deliberately absent: granting it would also hand the Run `config`, `hooks`, and every sibling
// Worktree's state, so one stray `git config` becomes repository-wide damage that every Worktree and
// the human inherit. A Worktree's own index and HEAD live under its entry, which it may write.
// `packed-refs.lock` does not exist yet and is still granted: Git creates it in the common
// directory's root, which stays ungranted, and without it every ref update against packed refs
// reports a lock failure into the Run's own transcript.
const commonGitWritableEntries = ["objects", "refs", "logs", "packed-refs", "packed-refs.lock"];

const resolveGitWritablePaths = Effect.fn("ExternalHarnessRuntime.resolveGitWritablePaths")(
  (checkoutPath: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const worktreeGitPath = path.resolve(checkoutPath, ".git");
      const info = yield* fs.stat(worktreeGitPath);
      // A checkout whose `.git` is a real directory gets nothing. It cannot be narrowed — Git writes
      // the index by creating `index.lock` in that directory's root, so a commit needs the directory
      // itself — and that directory is the common one every linked Worktree shares, which is exactly
      // what this derivation exists to withhold. Granting it back would undo the whole narrowing.
      if (info.type === "Directory") return [];

      const pointer = yield* fs.readFileString(worktreeGitPath);
      const gitDirectoryMatch = /^gitdir:\s*(.+)$/m.exec(pointer.trim());
      if (!gitDirectoryMatch?.[1]) return yield* sharedGitError(checkoutPath);

      const gitDirectory = yield* fs.realPath(path.resolve(checkoutPath, gitDirectoryMatch[1]));
      const commonDirectoryPath = path.resolve(gitDirectory, "commondir");
      const commonDirectory = yield* fs
        .readFileString(commonDirectoryPath)
        .pipe(Effect.orElseSucceed(() => "."));
      const common = yield* fs.realPath(path.resolve(gitDirectory, commonDirectory.trim()));
      return [gitDirectory, ...commonGitWritableEntries.map((entry) => path.join(common, entry))];
    }),
);

// A read-only Operation commits nothing, so it is granted nothing: Codex protects `<checkout>/.git`
// on its own, and an `--add-dir` over that path overrides the protection.
const gitWritablePaths = (
  descriptor: { readonly sharedGit: ExternalHarnessDescriptor<AnyTextAdapter>["sharedGit"] },
  profile: OperationPolicyProfile,
  checkoutPath: string,
) => {
  if (descriptor.sharedGit === "none" || profile === "read-only") {
    return Effect.succeed<ReadonlyArray<string>>([]);
  }
  return resolveGitWritablePaths(checkoutPath).pipe(Effect.mapError(() => sharedGitError(checkoutPath)));
};

const resolvedRequest = Effect.fn("ExternalHarnessRuntime.resolveRequest")(function* (
  descriptor: { readonly sharedGit: ExternalHarnessDescriptor<AnyTextAdapter>["sharedGit"] },
  request: HarnessRequest,
  session: SessionId,
  authentication: ExternalHarnessAuthentication,
) {
  const resumeHandle = yield* resolveResumeHandle(session);
  const writablePaths = yield* gitWritablePaths(
    descriptor,
    request.plan.harness.profile,
    request.plan.sandbox.workspace,
  );
  return {
    identity: { run: request.plan.id, session, resumeHandle },
    selection: { model: request.plan.harness.model, effort: request.plan.harness.effort },
    authentication,
    policy: request.plan.harness.profile,
    instructions: request.plan.instructions,
    operatingInstructions: request.plan.operatingInstructions,
    mcp: resolvedMcpSkills(request),
    secrets: { mcp: request.mcpCredentials },
    checkout: { path: request.plan.sandbox.workspace, gitWritablePaths: writablePaths },
    prompt: request.plan.messages,
    outputSchema: request.plan.structuredOutput,
  } satisfies ExternalHarnessResolvedRequest;
});

const resolveExternalLaunch = Effect.fn("ExternalHarnessRuntime.resolveLaunch")(function* <
  Adapter extends AnyTextAdapter,
>(
  descriptor: ExternalHarnessDescriptor<Adapter>,
  inputs: ExternalHarnessRuntimeInputs,
  request: HarnessRequest,
) {
  const session = yield* requireSession(request.session);
  const authentication = yield* inputs.authentication(request);
  const resolved = yield* resolvedRequest(descriptor, request, session, authentication);
  yield* validateExternalRequest(descriptor, request, resolved);
  const workspaceDefinition = harnessWorkspace(descriptor, resolved);
  const provider = localProcessSandboxProvider(resolved.checkout.path, {
    inherited: descriptor.inheritedEnvironment,
    allowed: Object.keys(workspaceDefinition.secrets ?? {}),
  });
  return {
    resolved,
    provider,
    workspaceDefinition,
    secretValues: workspaceSecretValues(workspaceDefinition),
  };
});

const outputCharacters = (event: AgUiEvent) =>
  AgUiEvent.guards.TEXT_MESSAGE_CONTENT(event) || AgUiEvent.guards.REASONING_MESSAGE_CONTENT(event)
    ? (event.delta?.length ?? 0)
    : 0;

const relativeToRoot = (path: string, root: string) => {
  const normalizedPath = path.replace(/^\/+/, "");
  const normalizedRoot = root.replace(/^\/+|\/+$/g, "");
  if (normalizedPath === normalizedRoot) return ".";
  const prefix = `${normalizedRoot}/`;
  return normalizedPath.startsWith(prefix) ? normalizedPath.slice(prefix.length) : path;
};

const normalizeFileDiffValue = (value: unknown, checkoutPath: string) => {
  if (typeof value !== "object" || value === null || !("path" in value)) return value;
  if (typeof value.path !== "string") return value;
  const workspacePath = relativeToRoot(value.path, DEFAULT_WORKSPACE_ROOT);
  return { ...value, path: relativeToRoot(workspacePath, checkoutPath) };
};

const normalizeFileEvent = (event: AgUiEvent, checkoutPath: string) => {
  if (!AgUiEvent.guards.CUSTOM(event)) return event;
  const name = event.name === "file.changed" ? FILE_DIFF_EVENT : event.name;
  if (name !== FILE_DIFF_EVENT) return event;
  const normalized = { ...event, name, value: normalizeFileDiffValue(event.value, checkoutPath) };
  if (!agUiIsFileDiffEvent(normalized)) return event;
  // A native whole-worktree diff is unbounded at the source. The owned diff feed
  // holds the same client contract to one bound, so hold this path to it too
  // rather than persisting and rendering a multi-megabyte string.
  return { ...normalized, value: { ...normalized.value, diff: boundedDiff(normalized.value.diff) } };
};

const publicFileEvent = (event: AgUiEvent) => {
  // A native file event that could not carry the shared contract keeps its native
  // name through `normalizeFileEvent`. TanStack's payload makes `diff` optional, so
  // this is a real shape, and it has no diff to show — drop it rather than persist
  // an event under a name no client reads.
  if (AgUiEvent.guards.CUSTOM(event) && event.name === "file.changed") return false;
  if (!agUiIsFileDiffEvent(event)) return true;
  // A touched-but-unchanged file still reports a change; an empty diff would render
  // as an activity entry with nothing in it.
  if (event.value.diff === "") return false;
  return !ignored(event.value.path);
};

const preserveUsage: ExternalHarnessUsageEstimator = (_request, event) => event;

const withUsage = (
  request: ExternalHarnessResolvedRequest,
  estimate: ExternalHarnessUsageEstimator,
  stream: Stream.Stream<AgUiEvent, HarnessError>,
) =>
  Stream.mapAccum(
    stream,
    () => 0,
    (characters, event): readonly [number, ReadonlyArray<AgUiEvent>] => {
      const next = characters + outputCharacters(event);
      return [next, [estimate(request, event, next)]];
    },
  );

const makeChatStream = <Adapter extends AnyTextAdapter>(
  descriptor: ExternalHarnessDescriptor<Adapter>,
  request: ExternalHarnessResolvedRequest,
  adapter: Adapter,
  middleware: ReadonlyArray<ChatMiddleware>,
  abortController: AbortController,
  secretValues: ReadonlyArray<string>,
) =>
  chat({
    adapter,
    messages: request.prompt.map(({ role, content }) => ({ role, content })),
    systemPrompts:
      descriptor.transport.instructionProjection === "system-prompt" ? [workspaceInstructions(request)] : [],
    middleware: [...middleware],
    abortController,
    modelOptions: descriptor.projectOptions(request),
    outputSchema: request.outputSchema ?? undefined,
    threadId: request.identity.session,
    runId: request.identity.run,
    stream: true,
    ...(secretValues.length > 0 ? { debug: false } : {}),
  });

const abortOnReturn = <Value>(stream: AsyncIterable<Value>, abortController: AbortController) => ({
  [Symbol.asyncIterator]: () => {
    const iterator = stream[Symbol.asyncIterator]();
    return {
      next: () => iterator.next(),
      return: (value?: unknown): Promise<IteratorResult<Value>> => {
        abortController.abort(RUN_CANCEL_REASON);
        if (iterator.return) {
          return iterator.return(value);
        }
        return Promise.resolve({ done: true, value: undefined });
      },
    };
  },
});

const checkoutFileDiffs = (
  checkoutPath: string,
  secretValues: ReadonlyArray<string>,
  stop: Effect.Effect<void>,
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const sandbox = yield* openWorktreeSandbox(checkoutPath);
      const baseSha = yield* resolveBaseSha(sandbox);
      return watchWorktreeDiffs(sandbox, baseSha, stop);
    }),
  ).pipe(Stream.map((event) => scrubEvent(event, secretValues)));

// A client stops reading at the terminal event, so the feed must drain first.
// `RUN_ERROR` is not held: the stream fails right behind it.
export const mergeCheckoutFileDiffs = Effect.fn("ExternalHarnessRuntime.mergeCheckoutFileDiffs")(function* <
  E,
  R,
>(
  harnessEvents: Stream.Stream<AgUiEvent, HarnessError>,
  fileDiffs: (stop: Effect.Effect<void>) => Stream.Stream<AgUiEvent, E, R>,
) {
  return yield* mergeFileDiffFeed(harnessEvents, fileDiffs, "checkout file-diff feed stopped");
});

const openChat = <Adapter extends AnyTextAdapter>(
  descriptor: ExternalHarnessDescriptor<Adapter>,
  request: ExternalHarnessResolvedRequest,
  provider: SandboxProvider,
  workspaceDefinition: WorkspaceDefinition,
  secretValues: ReadonlyArray<string>,
) => {
  const model = descriptor.projectModel(request);
  const adapter = descriptor.makeAdapter({ model, nativeAuthentication: "host", request });
  const policy = policyForProfile(request.policy);
  const sandbox = defineSandbox({
    id: `cogwork-${descriptor.name}`,
    provider,
    workspace: defineWorkspace(workspaceDefinition),
    lifecycle: { reuse: "none", snapshot: "none", destroyOnComplete: true },
    policy,
    // Kept off: turning it on retains one diff promise per filesystem event for the whole Run.
    fileEvents: false,
  });
  const abortController = new AbortController();
  const middleware = [
    withSandbox(sandbox),
    ...(writesWorkspaceFiles(workspaceDefinition) ? [] : [satisfiedProjection()]),
  ];
  const stream = makeChatStream(descriptor, request, adapter, middleware, abortController, secretValues);
  return { abortController, stream };
};

export const externalHarnessRunner = <Adapter extends AnyTextAdapter>(
  descriptor: ExternalHarnessDescriptor<Adapter>,
  inputs: ExternalHarnessRuntimeInputs,
): HarnessRunner => {
  const preflightPhase = HarnessPreflightInput.$match({
    Static: () => Effect.void,
    Launch: ({ request }) => resolveExternalLaunch(descriptor, inputs, request).pipe(Effect.asVoid),
  });
  const preflight = Effect.fn("ExternalHarnessRuntime.preflight")((input: HarnessPreflightInput) =>
    preflightPhase(input),
  );
  return {
    name: descriptor.name,
    ...externalHarnessDeclaration,
    execution: descriptor.capabilities.execution,
    capabilities: descriptor.capabilities.profile,
    authentication: descriptor.authentication,
    ...(descriptor.signIn ? { signIn: descriptor.signIn } : {}),
    catalogSources: descriptor.catalogSources,
    readiness: descriptor.readiness,
    validateLaunch: (request) => validateCheckoutDirectory(descriptor.name, request.plan.sandbox.workspace),
    preflight,
    run: (request) =>
      Stream.unwrap(
        resolveExternalLaunch(descriptor, inputs, request).pipe(
          Effect.flatMap(({ resolved, provider, workspaceDefinition, secretValues }) =>
            Effect.try({
              try: () => openChat(descriptor, resolved, provider, workspaceDefinition, secretValues),
              catch: descriptor.diagnostics,
            }).pipe(
              Effect.mapError((error) => scrubHarnessError(error, secretValues)),
              Effect.flatMap((opened) => {
                const harnessEvents = withUsage(
                  resolved,
                  descriptor.estimateUsage ?? preserveUsage,
                  bridgeChat(
                    abortOnReturn(opened.stream, opened.abortController),
                    descriptor.turnDiagnostics ?? descriptor.diagnostics,
                    descriptor.turnDiagnostics ?? descriptor.diagnostics,
                  ).pipe(
                    Stream.map((event) => normalizeFileEvent(event, resolved.checkout.path)),
                    Stream.filter(publicFileEvent),
                    Stream.map((event) => scrubEvent(event, secretValues)),
                    Stream.mapError((error) => scrubHarnessError(error, secretValues)),
                    Stream.ensuring(Effect.sync(() => opened.abortController.abort())),
                  ),
                );
                return descriptor.transport.runtimeFileDiffFeed
                  ? mergeCheckoutFileDiffs(harnessEvents, (stop) =>
                      checkoutFileDiffs(resolved.checkout.path, secretValues, stop),
                    )
                  : Effect.succeed(harnessEvents);
              }),
            ),
          ),
          Effect.withSpan("ExternalHarnessRuntime.run"),
        ),
      ),
  };
};

export const environmentVariablesToRemove = (
  environment: ReadonlyArray<string>,
  inherited: ReadonlyArray<string>,
  allowed: ReadonlyArray<string> = [],
  denied: ReadonlyArray<string> = [],
) => {
  const environmentName = (name: string) => (process.platform === "win32" ? name.toUpperCase() : name);
  const deniedNames = new Set(denied.map(environmentName));
  const inheritedNames = new Set(
    [...inherited, ...allowed].map(environmentName).filter((name) => !deniedNames.has(name)),
  );
  return environment.filter((name) => !inheritedNames.has(environmentName(name)));
};

interface EnvironmentRule {
  readonly inherited: ReadonlyArray<string>;
  readonly allowed?: ReadonlyArray<string>;
  readonly denied?: ReadonlyArray<string>;
}

const withCurrentEnvironment = <Value>(refreshEnvironment: () => void, action: () => Value) => {
  refreshEnvironment();
  return action();
};

const sandboxWithCurrentEnvironment = (
  sandbox: SandboxHandle,
  refreshEnvironment: () => void,
): SandboxHandle => ({
  ...sandbox,
  process: {
    ...sandbox.process,
    exec: (command, options) =>
      withCurrentEnvironment(refreshEnvironment, () => sandbox.process.exec(command, options)),
    spawn: (command, options) =>
      withCurrentEnvironment(refreshEnvironment, () => sandbox.process.spawn(command, options)),
  },
  git: {
    ...sandbox.git,
    clone: (input) => withCurrentEnvironment(refreshEnvironment, () => sandbox.git.clone(input)),
    status: (directory) => withCurrentEnvironment(refreshEnvironment, () => sandbox.git.status(directory)),
    add: (paths, directory) =>
      withCurrentEnvironment(refreshEnvironment, () => sandbox.git.add(paths, directory)),
    commit: (message, directory) =>
      withCurrentEnvironment(refreshEnvironment, () => sandbox.git.commit(message, directory)),
    push: (directory) => withCurrentEnvironment(refreshEnvironment, () => sandbox.git.push(directory)),
    pull: (directory) => withCurrentEnvironment(refreshEnvironment, () => sandbox.git.pull(directory)),
    branch: (directory) => withCurrentEnvironment(refreshEnvironment, () => sandbox.git.branch(directory)),
  },
  destroy: () => sandbox.destroy(),
});

const localProcessSandboxProvider = (directory: string, rule: EnvironmentRule) => {
  const scrubEnv: Array<string> = [];
  const refreshEnvironment = () => {
    scrubEnv.splice(
      0,
      scrubEnv.length,
      ...environmentVariablesToRemove(Object.keys(process.env), rule.inherited, rule.allowed, rule.denied),
    );
  };
  refreshEnvironment();
  const handles = new Map<string, SandboxHandle>();
  const provider = localProcessSandbox({
    dir: directory,
    scrubEnv,
  });
  const register = (sandbox: SandboxHandle) => {
    const current = sandboxWithCurrentEnvironment(sandbox, refreshEnvironment);
    handles.set(current.id, current);
    return current;
  };
  return {
    name: provider.name,
    capabilities: () => provider.capabilities(),
    create: (input) => {
      refreshEnvironment();
      return provider.create(input).then(register);
    },
    resume: (input) => {
      refreshEnvironment();
      return provider.resume(input).then((sandbox) => (sandbox ? register(sandbox) : null));
    },
    destroy: (input) => {
      const handle = handles.get(input.id);
      if (!handle) return provider.destroy(input);
      handles.delete(input.id);
      return handle.destroy();
    },
  } satisfies SandboxProvider;
};

export const withLocalProcessSandbox = <Value, Error, Requirements>(
  directory: string,
  inheritedEnvironment: ReadonlyArray<string>,
  onCreateError: (cause: unknown) => Error,
  use: (sandbox: SandboxHandle) => Effect.Effect<Value, Error, Requirements>,
) =>
  Effect.scoped(
    Effect.acquireRelease(
      Effect.tryPromise({
        try: () => localProcessSandboxProvider(directory, { inherited: inheritedEnvironment }).create({}),
        catch: onCreateError,
      }),
      (sandbox) => Effect.tryPromise({ try: () => sandbox.destroy(), catch: () => null }).pipe(Effect.ignore),
    ).pipe(Effect.flatMap(use)),
  );
