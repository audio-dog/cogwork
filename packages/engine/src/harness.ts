import {
  type AgUiEvent,
  type HarnessName,
  ImplementStageResult,
  type LifecycleStage,
  type SessionId,
  type SessionKind,
  TriageStageResult,
} from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ContextAssembler, type ContextAssemblerService } from "./context-assembler";
import { CredentialStore, type CredentialStoreService } from "./credential-store";
import type { ResolvedMcpSkill } from "./mcp-skill";
import { SessionStore, type SessionStoreService } from "./session-store";

export type { AgUiEvent } from "@cogwork/contracts";
export type { ResolvedMcpSkill } from "./mcp-skill";

const triageResultSchema = Schema.toStandardJSONSchemaV1(
  Schema.toStandardSchemaV1(Schema.Struct(TriageStageResult.fields)),
);
const implementResultSchema = Schema.toStandardJSONSchemaV1(
  Schema.toStandardSchemaV1(Schema.Struct(ImplementStageResult.fields)),
);

const stageSchemas = {
  triage: triageResultSchema,
  implement: implementResultSchema,
} as const satisfies Partial<
  Record<LifecycleStage, typeof triageResultSchema | typeof implementResultSchema>
>;

export const stageResultSchema = (stage: LifecycleStage) => {
  if (stage === "triage") return stageSchemas.triage;
  if (stage === "implement") return stageSchemas.implement;
  return undefined;
};
export type StageResultSchema = typeof triageResultSchema | typeof implementResultSchema;

export interface HarnessRequest {
  readonly harness: HarnessName;
  readonly stage: LifecycleStage;
  readonly skill: string;
  readonly checkoutPath: string;
  readonly session: SessionId | null;
  readonly prompt: string;
  readonly model: string | null;
  readonly effort: string | null;
  readonly mcpSkills: ReadonlyArray<ResolvedMcpSkill>;
}

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

export const make = (
  runners: ReadonlyArray<HarnessRunner>,
  services: HarnessRunnerServices,
): HarnessService => {
  const registry = new Map(runners.map((runner) => [runner.name, runner] as const));
  return {
    run: (request) => {
      const runner = registry.get(request.harness);
      const stream = runner ? runner.run(request) : Stream.fail(unknownHarness(request.harness));
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
