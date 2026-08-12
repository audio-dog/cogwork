import type { AgUiEvent, HarnessName, LifecycleStage, SessionId } from "@clanker-forge/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ContextAssembler, type ContextAssemblerService } from "./context-assembler";
import { CredentialStore, type CredentialStoreService } from "./credential-store";
import type { ResolvedMcpSkill } from "./mcp-skill";
import { SessionStore, type SessionStoreService } from "./session-store";

export type { AgUiEvent } from "@clanker-forge/contracts";
export type { ResolvedMcpSkill } from "./mcp-skill";

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

export class HarnessError extends Schema.TaggedErrorClass<HarnessError>()("HarnessError", {
  reason: Schema.Literals(["unknown-harness", "launch", "turn"]),
  retryable: Schema.Boolean,
  message: Schema.String,
}) {}

export interface HarnessRunner {
  readonly name: HarnessName;
  readonly run: (request: HarnessRequest) => Stream.Stream<AgUiEvent, HarnessError, HarnessRunnerEnv>;
}

export interface HarnessService {
  readonly run: (request: HarnessRequest) => Stream.Stream<AgUiEvent, HarnessError>;
}

export class Harness extends Context.Service<Harness, HarnessService>()("@clanker-forge/engine/harness") {}

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
