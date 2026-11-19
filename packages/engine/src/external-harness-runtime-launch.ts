import type { HarnessName, SessionId } from "@cogwork/contracts";
import type { AnyTextAdapter } from "@tanstack/ai";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type {
  ExternalHarnessAuthentication,
  ExternalHarnessDescriptor,
  ExternalHarnessResolvedRequest,
  ExternalHarnessRuntimeInputs,
} from "./external-harness-runtime";
import { localProcessSandboxProvider } from "./external-harness-runtime-local-process";
import { harnessWorkspace, workspaceSecretValues } from "./external-harness-runtime-workspace";
import {
  type HarnessAuthenticationMode,
  HarnessError,
  type HarnessRequest,
  type OperationPolicyProfile,
  resolvedMcpSkills,
  validateCheckoutDirectory,
} from "./harness";
import { workContextMessage } from "./run-plan";
import { SessionStore } from "./session-store";
import { availableSubagents } from "./subagent-runner";

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

const projectedTools = (request: HarnessRequest) =>
  request.engineTools?.filter(({ name }) => request.plan.tools.includes(name)) ?? [];

const resolvedRequest = Effect.fn("ExternalHarnessRuntime.resolveRequest")(function* (
  descriptor: Pick<ExternalHarnessDescriptor<AnyTextAdapter>, "sharedGit" | "declaredMembers">,
  request: HarnessRequest,
  checkoutPath: string,
  session: SessionId,
  authentication: ExternalHarnessAuthentication,
) {
  const resumeHandle = yield* resolveResumeHandle(session);
  const writablePaths = yield* gitWritablePaths(descriptor, request.plan.harness.profile, checkoutPath);
  return {
    identity: { run: request.plan.id, session, resumeHandle },
    selection: { model: request.plan.harness.model, options: request.plan.harness.options },
    authentication,
    policy: request.plan.harness.profile,
    instructions: request.plan.instructions,
    operatingInstructions: request.plan.operatingInstructions,
    mcp: resolvedMcpSkills(request),
    secrets: { mcp: request.mcpCredentials },
    checkout: { path: checkoutPath, gitWritablePaths: writablePaths },
    prompt: [workContextMessage(request.plan.workContext), ...request.plan.messages],
    outputSchema: request.plan.structuredOutput,
    tools: projectedTools(request),
    subagents: descriptor.declaredMembers?.includes("Subagents")
      ? availableSubagents(request.plan.subagents)
      : [],
  } satisfies ExternalHarnessResolvedRequest;
});

export const resolveExternalLaunch = Effect.fn("ExternalHarnessRuntime.resolveLaunch")(function* <
  Adapter extends AnyTextAdapter,
>(
  descriptor: ExternalHarnessDescriptor<Adapter>,
  inputs: ExternalHarnessRuntimeInputs,
  request: HarnessRequest,
) {
  const checkoutPath = yield* validateCheckoutDirectory(descriptor.name, request.plan.sandbox.workspace);
  const session = yield* requireSession(request.session);
  const authentication = yield* inputs.authentication(request);
  const resolved = yield* resolvedRequest(descriptor, request, checkoutPath, session, authentication);
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
