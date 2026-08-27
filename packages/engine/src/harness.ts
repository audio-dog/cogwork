import {
  type AgUiEvent,
  type HarnessName,
  type LifecycleStage,
  type SessionId,
  type SessionKind,
  type StageResultJsonSchema,
  stageResultJsonSchema,
} from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
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

// CLI harnesses only reach for SessionStore; the wider set is provided uniformly
// so the provider runner can assemble context and resolve its provider key.
export type HarnessRunnerEnv = SessionStore | ContextAssembler | CredentialStore;

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
  readonly run: (request: HarnessRequest) => Stream.Stream<AgUiEvent, HarnessError>;
  // An unregistered harness falls back to opaque-handle: its run fails at
  // dispatch anyway, and that was the one kind every session took before.
  readonly sessionKind: (harness: HarnessName) => SessionKind;
}

export class Harness extends Context.Service<Harness, HarnessService>()("@cogwork/engine/harness") {}

export interface HarnessRunnerServices {
  readonly sessionStore: SessionStoreService;
  readonly contextAssembler: ContextAssemblerService;
  readonly credentialStore: CredentialStoreService;
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

export const make = (
  runners: ReadonlyArray<HarnessRunner>,
  services: HarnessRunnerServices,
): HarnessService => {
  const registry = new Map(runners.map((runner) => [runner.name, runner] as const));
  return {
    run: (request) => {
      const runner = registry.get(request.harness);
      const posture = runner ? unsupportedPosture(runner, request.profile) : null;
      const stream = runner
        ? posture
          ? Stream.fail(unsupportedRunnerPosture(runner, request.profile, posture))
          : runner.run(request)
        : Stream.fail(unknownHarness(request.harness));
      return stream.pipe(
        Stream.provideService(SessionStore, services.sessionStore),
        Stream.provideService(ContextAssembler, services.contextAssembler),
        Stream.provideService(CredentialStore, services.credentialStore),
      );
    },
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
      }),
      (services) => make(runners, services),
    ),
  );
