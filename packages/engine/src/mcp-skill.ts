import type { McpSkill, WorkspaceConfig } from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";

import {
  type CredentialAccount,
  CredentialError,
  CredentialStore,
  type CredentialStoreService,
} from "./credential-store";
import { credentialAccountFor as linearCredentialAccountFor } from "./linear/account";

// The bearer rides a `Redacted` so a stray log of the request cannot leak it; the harness runner is
// the only place that unwraps it.
export interface ResolvedMcpSkill {
  readonly name: string;
  readonly endpoint: string;
  readonly bearer: Redacted.Redacted<string> | null;
  readonly unavailableReason?: string | null;
}

// Injected so the assembler stays free of any one issue tracker's config shape.
export type CredentialAccountFor = (config: WorkspaceConfig) => CredentialAccount | null;

export interface McpSkillAssemblerService {
  readonly assemble: (
    config: WorkspaceConfig,
  ) => Effect.Effect<ReadonlyArray<ResolvedMcpSkill>, CredentialError>;
}

export class McpSkillAssembler extends Context.Service<McpSkillAssembler, McpSkillAssemblerService>()(
  "@cogwork/engine/mcp-skill/McpSkillAssembler",
) {}

export const make = (
  store: CredentialStoreService,
  accountFor: CredentialAccountFor,
): McpSkillAssemblerService => {
  const resolveBearer = Effect.fn("McpSkillAssembler.resolveBearer")(function* (
    config: WorkspaceConfig,
    skill: McpSkill,
  ) {
    if (!skill.auth) return null;
    const account = accountFor(config);
    if (!account) {
      return yield* new CredentialError({
        account: config.id,
        message: `MCP skill "${skill.name}" needs a credential-store bearer, but workspace ${config.id} has no credential account to source it from`,
        retryable: false,
      });
    }
    const credential = yield* store.bearerToken(account);
    return credential.token;
  });

  return {
    assemble: Effect.fn("McpSkillAssembler.assemble")(function* (config: WorkspaceConfig) {
      const skills = config.mcpSkills ?? [];
      return yield* Effect.forEach(skills, (skill) =>
        resolveBearer(config, skill).pipe(
          Effect.match({
            onFailure: (error) =>
              ({
                name: skill.name,
                endpoint: skill.endpoint,
                bearer: null,
                unavailableReason: error.message,
              }) satisfies ResolvedMcpSkill,
            onSuccess: (bearer) =>
              ({
                name: skill.name,
                endpoint: skill.endpoint,
                bearer,
                unavailableReason: null,
              }) satisfies ResolvedMcpSkill,
          }),
        ),
      );
    }),
  };
};

const routedCredentialAccountFor: CredentialAccountFor = (config) =>
  config.issueTracker.type === "linear" ? linearCredentialAccountFor(config) : null;

export const layer = Layer.effect(
  McpSkillAssembler,
  Effect.map(CredentialStore, (store) => make(store, routedCredentialAccountFor)),
);
