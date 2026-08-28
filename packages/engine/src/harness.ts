import {
  type AgUiEvent,
  type HarnessName,
  type LifecycleStage,
  type LocalContribution,
  type SessionId,
  type SessionKind,
  type StageResultJsonSchema,
  stageResultJsonSchema,
} from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ContextAssembler, type ContextAssemblerService } from "./context-assembler";
import { CredentialStore, type CredentialStoreService } from "./credential-store";
import type { ResolvedMcpSkill } from "./mcp-skill";
import type { OperationPolicyProfile } from "./operation-policy";
import { SessionStore, type SessionStoreService } from "./session-store";

export type { AgUiEvent } from "@cogwork/contracts";
export type { ResolvedMcpSkill } from "./mcp-skill";
export type { OperationPolicyProfile } from "./operation-policy";

export const stageResultSchema = stageResultJsonSchema;
export type StageResultSchema = StageResultJsonSchema;

export interface HarnessRequest {
  readonly harness: HarnessName;
  readonly stage: LifecycleStage;
  readonly profile: OperationPolicyProfile;
  readonly skill: string;
  readonly checkoutPath: string;
  readonly session: SessionId | null;
  readonly prompt: string;
  readonly model: string | null;
  readonly effort: string | null;
  readonly mcpSkills: ReadonlyArray<ResolvedMcpSkill>;
  readonly contributions: ReadonlyArray<LocalContribution>;
}

export interface HarnessExecution {
  readonly nonInteractive: boolean;
  readonly worktreeConfined: boolean;
  readonly profiles: ReadonlyArray<OperationPolicyProfile>;
}

export const fullHarnessExecution: HarnessExecution = {
  nonInteractive: true,
  worktreeConfined: true,
  profiles: ["read-only", "full"],
};

export type HarnessRunnerEnv = SessionStore | ContextAssembler | CredentialStore | FileSystem.FileSystem;

export class HarnessError extends Schema.TaggedError<HarnessError>()("HarnessError", {
  reason: Schema.Literals(["unknown-harness", "launch", "turn"]),
  retryable: Schema.Boolean,
  message: Schema.String,
}) {}

export interface HarnessRunner {
  readonly name: HarnessName;
  readonly sessionKind: SessionKind;
  readonly execution: HarnessExecution;
  readonly run: (request: HarnessRequest) => Stream.Stream<AgUiEvent, HarnessError, HarnessRunnerEnv>;
}

export interface HarnessService {
  readonly preflight: (
    harness: HarnessName,
    profile: OperationPolicyProfile,
  ) => Effect.Effect<void, HarnessError>;
  readonly run: (request: HarnessRequest) => Stream.Stream<AgUiEvent, HarnessError>;
  readonly sessionKind: (harness: HarnessName) => SessionKind;
}

export class Harness extends Context.Service<Harness, HarnessService>()("@cogwork/engine/harness") {}

export interface HarnessRunnerServices {
  readonly sessionStore: SessionStoreService;
  readonly contextAssembler: ContextAssemblerService;
  readonly credentialStore: CredentialStoreService;
  readonly fileSystem: FileSystem.FileSystem;
}

const unknownHarness = (harness: HarnessName) =>
  new HarnessError({
    reason: "unknown-harness",
    retryable: false,
    message: `no harness runner registered for ${harness}`,
  });

const unsupportedPosture = (runner: HarnessRunner, profile: OperationPolicyProfile) => {
  if (!runner.execution.nonInteractive) return "a non-interactive turn";
  if (!runner.execution.worktreeConfined) return "worktree confinement";
  if (!runner.execution.profiles.includes(profile)) return `${profile} operation posture`;
  return null;
};

const unsupportedRunnerPosture = (runner: HarnessRunner, profile: OperationPolicyProfile, posture: string) =>
  new HarnessError({
    reason: "launch",
    retryable: false,
    message: `harness runner ${runner.name} cannot enforce ${posture} for the ${profile} profile`,
  });

const preflightRunner = (
  registry: ReadonlyMap<HarnessName, HarnessRunner>,
  harness: HarnessName,
  profile: OperationPolicyProfile,
) => {
  const runner = registry.get(harness);
  if (!runner) return Effect.fail(unknownHarness(harness));
  const posture = unsupportedPosture(runner, profile);
  if (posture) return Effect.fail(unsupportedRunnerPosture(runner, profile, posture));
  return Effect.succeed(runner);
};

export const make = (
  runners: ReadonlyArray<HarnessRunner>,
  services: HarnessRunnerServices,
): HarnessService => {
  const registry = new Map(runners.map((runner) => [runner.name, runner] as const));
  return {
    preflight: (harness, profile) => preflightRunner(registry, harness, profile).pipe(Effect.asVoid),
    run: (request) =>
      Stream.fromEffect(preflightRunner(registry, request.harness, request.profile)).pipe(
        Stream.flatMap((runner) => runner.run(request)),
        Stream.provideService(SessionStore, services.sessionStore),
        Stream.provideService(ContextAssembler, services.contextAssembler),
        Stream.provideService(CredentialStore, services.credentialStore),
        Stream.provideService(FileSystem.FileSystem, services.fileSystem),
      ),
    sessionKind: (harness) => registry.get(harness)?.sessionKind ?? "opaque-handle",
  };
};

export const layer = (runners: ReadonlyArray<HarnessRunner>) =>
  Layer.effect(
    Harness,
    Effect.map(
      Effect.all({
        sessionStore: SessionStore,
        contextAssembler: ContextAssembler,
        credentialStore: CredentialStore,
        fileSystem: FileSystem.FileSystem,
      }),
      (services) => make(runners, services),
    ),
  );
