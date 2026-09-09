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
  type SessionKind,
} from "@cogwork/contracts";
import {
  type AnyTextAdapter,
  type ChatMiddleware,
  type ConstrainedModelMessage,
  chat,
  type JSONSchema,
  type ModelMessage,
  RUN_CANCEL_REASON,
  type SystemPrompt,
} from "@tanstack/ai";
import { scrubSecrets } from "@tanstack/ai/byok";
import {
  bearer,
  createSecrets,
  DEFAULT_WORKSPACE_ROOT,
  defineSandbox,
  defineWorkspace,
  getSandbox,
  mcpSkill,
  ProjectionCapability,
  provideWorkspaceProjection,
  resolveAllSecrets,
  resolveHarnessCwd,
  type SandboxPolicy,
  type SandboxProvider,
  type Secrets,
  type WorkspaceDefinition,
  withSandbox,
} from "@tanstack/ai-sandbox";
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
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
} from "./harness";
import { bridgeChat } from "./provider-bridge";
import { SessionStore } from "./session-store";
import { boundedDiff, ignored, tolerateFeedDeath, watchWorktreeDiffs } from "./tools/file-diff-feed";
import { openWorktreeSandbox, resolveBaseSha } from "./tools/sandbox";

type AdapterModel<Adapter extends AnyTextAdapter> = Adapter["model"];
type AdapterOptions<Adapter extends AnyTextAdapter> = Adapter["~types"]["providerOptions"];
type AdapterSystemPrompt<Adapter extends AnyTextAdapter> = SystemPrompt<
  Adapter["~types"]["systemPromptMetadata"]
>;
type AdapterMessage<Adapter extends AnyTextAdapter> = ConstrainedModelMessage<{
  inputModalities: Adapter["~types"]["inputModalities"];
  messageMetadataByModality: Adapter["~types"]["messageMetadataByModality"];
}>;

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
  readonly projectedMembers: HarnessRunner["projectedMembers"];
  readonly planMiddleware: HarnessRunner["planMiddleware"];
}

export interface ExternalHarnessTransport<Adapter extends AnyTextAdapter> {
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
  readonly messages?: (
    request: ExternalHarnessResolvedRequest,
  ) => ReadonlyArray<ModelMessage | AdapterMessage<Adapter>>;
  readonly systemPrompts?: (
    request: ExternalHarnessResolvedRequest,
  ) => ReadonlyArray<AdapterSystemPrompt<Adapter>>;
  readonly middleware?: (request: ExternalHarnessResolvedRequest) => ReadonlyArray<ChatMiddleware>;
}

export type ExternalHarnessUsageEstimator = (
  request: ExternalHarnessResolvedRequest,
  event: AgUiEvent,
  outputTextCharacters: number,
) => AgUiEvent;

export interface ExternalHarnessDescriptor<Adapter extends AnyTextAdapter, NativeAuthentication = unknown> {
  readonly name: HarnessName;
  readonly sessionKind: SessionKind;
  readonly capabilities: ExternalHarnessCapabilities;
  readonly authentication: HarnessAuthenticationBinding;
  readonly signIn?: string;
  readonly catalogSources: HarnessCatalogSources;
  readonly readiness: () => Effect.Effect<HarnessReadiness, never, HarnessRunnerEnv>;
  readonly sharedGit: "none" | "required";
  readonly makeAdapter: (input: {
    readonly model: AdapterModel<Adapter>;
    readonly authentication: NativeAuthentication;
    readonly request: ExternalHarnessResolvedRequest;
  }) => Adapter;
  readonly projectModel: (request: ExternalHarnessResolvedRequest) => AdapterModel<Adapter>;
  readonly projectOptions: (request: ExternalHarnessResolvedRequest) => AdapterOptions<Adapter>;
  readonly projectAuthentication: (authentication: ExternalHarnessAuthentication) => NativeAuthentication;
  readonly transport: ExternalHarnessTransport<Adapter>;
  readonly diagnostics: (cause: unknown) => HarnessError;
  readonly turnDiagnostics?: (cause: unknown) => HarnessError;
  readonly estimateUsage?: ExternalHarnessUsageEstimator;
}

type ExternalInputEffect<Value> = Effect.Effect<Value, HarnessError, HarnessRunnerEnv>;

export interface ExternalHarnessRuntimeInputs {
  readonly authentication: (request: HarnessRequest) => ExternalInputEffect<ExternalHarnessAuthentication>;
  readonly sandboxProvider: (request: ExternalHarnessResolvedRequest) => ExternalInputEffect<SandboxProvider>;
  readonly sandboxPolicy?: (request: ExternalHarnessResolvedRequest) => ExternalInputEffect<SandboxPolicy>;
}

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

const incompatibleSandbox = (name: HarnessName, capability: string) =>
  new HarnessError({
    reason: "sandbox",
    retryable: false,
    message: `Sandbox provider for harness runner ${name} does not support ${capability}`,
  });

const validateSandboxProvider = <Adapter extends AnyTextAdapter, NativeAuthentication>(
  descriptor: ExternalHarnessDescriptor<Adapter, NativeAuthentication>,
  provider: SandboxProvider,
) => {
  const capabilities = provider.capabilities();
  const missingCapability = [
    { supported: capabilities.fs, label: "filesystem access" },
    { supported: capabilities.exec, label: "command execution" },
    { supported: capabilities.backgroundProcesses, label: "background processes" },
    { supported: capabilities.killableProcesses, label: "killable processes" },
  ].find(({ supported }) => !supported);
  if (!missingCapability) return Effect.void;
  return Effect.fail(incompatibleSandbox(descriptor.name, missingCapability.label));
};
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

const harnessWorkspace = <Adapter extends AnyTextAdapter, NativeAuthentication>(
  descriptor: ExternalHarnessDescriptor<Adapter, NativeAuthentication>,
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
    const root = resolveHarnessCwd(getSandbox(context));
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
      markerPath: `${root}/.git`,
      root,
    });
  },
});

const requiredWorkspaceMembers = (request: ExternalHarnessResolvedRequest) => {
  const base = ["Instructions", "Messages", "Sandbox"] satisfies HarnessRunner["projectedMembers"];
  if (request.mcp.length === 0) return base;
  return [...base, "MCP" satisfies HarnessRunner["projectedMembers"][number]];
};

const validateWorkspaceProjection = Effect.fn("ExternalHarnessRuntime.validateWorkspaceProjection")(
  function* <Adapter extends AnyTextAdapter, NativeAuthentication>(
    descriptor: ExternalHarnessDescriptor<Adapter, NativeAuthentication>,
    request: HarnessRequest,
    resolved: ExternalHarnessResolvedRequest,
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
    const projected = new Set<string>(descriptor.capabilities.projectedMembers);
    const missing = requiredWorkspaceMembers(resolved).filter((member) => !projected.has(member));
    if (missing.length === 0) return;
    return yield* new HarnessError({
      reason: "workspace",
      retryable: false,
      message: `harness runner ${descriptor.name} cannot project required Harness Workspace members: ${missing.join(", ")}`,
    });
  },
);

const validateExternalRequest = Effect.fn("ExternalHarnessRuntime.validateRequest")(function* <
  Adapter extends AnyTextAdapter,
  NativeAuthentication,
>(
  descriptor: ExternalHarnessDescriptor<Adapter, NativeAuthentication>,
  request: HarnessRequest,
  resolved: ExternalHarnessResolvedRequest,
  provider: SandboxProvider,
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
  yield* validateWorkspaceProjection(descriptor, request, resolved);
  yield* validateSandboxProvider(descriptor, provider);
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
      // A checkout whose `.git` is a real directory cannot be narrowed: Git writes the index by
      // creating `index.lock` beside it, so committing needs the directory itself — which is also
      // the common directory every linked Worktree shares.
      if (info.type === "Directory") return [yield* fs.realPath(worktreeGitPath)];

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
    }).pipe(Effect.provide(Path.layer)),
);

// A read-only Operation commits nothing, so it is granted nothing: Codex protects `<checkout>/.git`
// on its own, and an `--add-dir` over that path overrides the protection. Withholding the paths
// rather than skipping resolution keeps the preflight, so a checkout whose Git metadata is
// unreachable still fails before the Run starts.
const gitWritablePaths = (
  descriptor: { readonly sharedGit: ExternalHarnessDescriptor<AnyTextAdapter>["sharedGit"] },
  profile: OperationPolicyProfile,
  checkoutPath: string,
) => {
  if (descriptor.sharedGit === "none") return Effect.succeed<ReadonlyArray<string>>([]);
  return resolveGitWritablePaths(checkoutPath).pipe(
    Effect.map((paths): ReadonlyArray<string> => (profile === "read-only" ? [] : paths)),
    Effect.mapError(() => sharedGitError(checkoutPath)),
  );
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
  NativeAuthentication,
>(
  descriptor: ExternalHarnessDescriptor<Adapter, NativeAuthentication>,
  inputs: ExternalHarnessRuntimeInputs,
  request: HarnessRequest,
) {
  const session = yield* requireSession(request.session);
  const authentication = yield* inputs.authentication(request);
  const resolved = yield* resolvedRequest(descriptor, request, session, authentication);
  const provider = yield* inputs.sandboxProvider(resolved);
  yield* validateExternalRequest(descriptor, request, resolved, provider);
  const workspaceDefinition = harnessWorkspace(descriptor, resolved);
  const policy = yield* inputs.sandboxPolicy?.(resolved) ?? Effect.succeed(null);
  return {
    resolved,
    provider,
    workspaceDefinition,
    secretValues: workspaceSecretValues(workspaceDefinition),
    policy,
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

const adapterMessages = <Adapter extends AnyTextAdapter, NativeAuthentication>(
  descriptor: ExternalHarnessDescriptor<Adapter, NativeAuthentication>,
  request: ExternalHarnessResolvedRequest,
) =>
  descriptor.transport.messages?.(request) ?? request.prompt.map(({ role, content }) => ({ role, content }));

const makeChatStream = <Adapter extends AnyTextAdapter, NativeAuthentication>(
  descriptor: ExternalHarnessDescriptor<Adapter, NativeAuthentication>,
  request: ExternalHarnessResolvedRequest,
  adapter: Adapter,
  middleware: ReadonlyArray<ChatMiddleware>,
  abortController: AbortController,
  secretValues: ReadonlyArray<string>,
) =>
  chat({
    adapter,
    messages: [...adapterMessages(descriptor, request)],
    systemPrompts: [
      ...(descriptor.transport.instructionProjection === "system-prompt"
        ? [workspaceInstructions(request)]
        : []),
      ...(descriptor.transport.systemPrompts?.(request) ?? []),
    ],
    middleware: [...middleware, ...(descriptor.transport.middleware?.(request) ?? [])],
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

// Not derived from the harness's own reported changes: Codex reports `file_change`
// only for its `apply_patch` tool, so a shell-driven edit carries no such item.
// Holding the terminal event on the drain means a stalled `git diff` would hold the
// Run, so the drain gets its own bound.
const feedDrainDeadline = "10 seconds";

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
  ).pipe(
    Stream.map((event) => scrubEvent(event, secretValues)),
    Stream.interruptWhen(Effect.andThen(stop, Effect.sleep(feedDrainDeadline))),
    tolerateFeedDeath("checkout file-diff feed stopped"),
  );

// A client stops reading at the terminal event, so the feed must drain first.
// `RUN_ERROR` is not held: the stream fails right behind it.
const mergeCheckoutFileDiffs = Effect.fn("ExternalHarnessRuntime.mergeCheckoutFileDiffs")(function* (
  harnessEvents: Stream.Stream<AgUiEvent, HarnessError>,
  checkoutPath: string,
  secretValues: ReadonlyArray<string>,
) {
  const harnessDone = yield* Deferred.make<void>();
  const withheldTerminal = yield* Ref.make<AgUiEvent | null>(null);
  return Stream.merge(
    harnessEvents.pipe(
      Stream.filterEffect((event) =>
        AgUiEvent.guards.RUN_FINISHED(event)
          ? Effect.map(Ref.set(withheldTerminal, event), () => false)
          : Effect.succeed(true),
      ),
      Stream.ensuring(Deferred.succeed(harnessDone, undefined)),
    ),
    checkoutFileDiffs(checkoutPath, secretValues, Deferred.await(harnessDone)),
    { haltStrategy: "both" },
  ).pipe(
    Stream.concat(
      Stream.unwrap(
        Effect.map(Ref.get(withheldTerminal), (event) =>
          event === null ? Stream.empty : Stream.make(event),
        ),
      ),
    ),
  );
});

const openChat = <Adapter extends AnyTextAdapter, NativeAuthentication>(
  descriptor: ExternalHarnessDescriptor<Adapter, NativeAuthentication>,
  request: ExternalHarnessResolvedRequest,
  provider: SandboxProvider,
  workspaceDefinition: WorkspaceDefinition,
  policy: SandboxPolicy | null,
  secretValues: ReadonlyArray<string>,
) => {
  const model = descriptor.projectModel(request);
  const nativeAuthentication = descriptor.projectAuthentication(request.authentication);
  const adapter = descriptor.makeAdapter({ model, authentication: nativeAuthentication, request });
  const sandbox = defineSandbox({
    id: `cogwork-${descriptor.name}`,
    provider,
    workspace: defineWorkspace(workspaceDefinition),
    lifecycle: { reuse: "none", snapshot: "none", destroyOnComplete: true },
    ...(policy ? { policy } : {}),
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

export const externalHarnessRunner = <Adapter extends AnyTextAdapter, NativeAuthentication>(
  descriptor: ExternalHarnessDescriptor<Adapter, NativeAuthentication>,
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
    sessionKind: descriptor.sessionKind,
    execution: descriptor.capabilities.execution,
    capabilities: descriptor.capabilities.profile,
    authentication: descriptor.authentication,
    ...(descriptor.signIn ? { signIn: descriptor.signIn } : {}),
    catalogSources: descriptor.catalogSources,
    readiness: descriptor.readiness,
    projectedMembers: descriptor.capabilities.projectedMembers,
    planMiddleware: descriptor.capabilities.planMiddleware,
    preflight,
    run: (request) =>
      Stream.unwrap(
        resolveExternalLaunch(descriptor, inputs, request).pipe(
          Effect.flatMap(({ resolved, provider, workspaceDefinition, secretValues, policy }) =>
            Effect.try({
              try: () => openChat(descriptor, resolved, provider, workspaceDefinition, policy, secretValues),
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
                  ? mergeCheckoutFileDiffs(harnessEvents, resolved.checkout.path, secretValues)
                  : Effect.succeed(harnessEvents);
              }),
            ),
          ),
          Effect.withSpan("ExternalHarnessRuntime.run"),
        ),
      ),
  };
};

export const trustedLocalProcessSandboxProvider =
  (options: { readonly scrubEnv: ReadonlyArray<string> }) => (request: ExternalHarnessResolvedRequest) =>
    Effect.succeed(
      localProcessSandbox({
        dir: request.checkout.path,
        scrubEnv: [...options.scrubEnv],
      }),
    );
