// @effect-diagnostics-next-line nodeBuiltinImport:off
import { createHash } from "node:crypto";

import { AgUiEvent } from "@cogwork/contracts";
import type { AnyTextAdapter, ChatMiddleware } from "@tanstack/ai";
import {
  bearer,
  createSecrets,
  DEFAULT_WORKSPACE_ROOT,
  mcpSkill,
  ProjectionCapability,
  provideWorkspaceProjection,
  resolveAllSecrets,
  type Secrets,
  type WorkspaceDefinition,
} from "@tanstack/ai-sandbox";
import { scrubSecrets } from "@tanstack/ai/byok";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import type { ExternalHarnessDescriptor, ExternalHarnessResolvedRequest } from "./external-harness-runtime";
import { HarnessError, type ResolvedMcpSkill } from "./harness";

const preparedWorkspace = { source: { type: "none" } } satisfies WorkspaceDefinition;

// Hex-hashed so the name is a valid environment identifier for any projected server name,
// and so a rotated credential never changes the name the harness is configured with. Shared
// with native MCP projection (the Codex descriptor), whose config references this name.
export const mcpBearerEnvironmentName = (server: string) =>
  `COGWORK_MCP_${createHash("sha256").update(server).digest("hex").toUpperCase()}_BEARER`;

export const workspaceInstructions = (request: ExternalHarnessResolvedRequest) =>
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

export const harnessWorkspace = <Adapter extends AnyTextAdapter>(
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

export const writesWorkspaceFiles = (definition: WorkspaceDefinition) =>
  definition.instructions !== undefined || definition.skills !== undefined;

export const workspaceSecretValues = (definition: WorkspaceDefinition) =>
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
  "subagentRunId",
  "parentToolCallId",
]);

const scrubValue = (value: unknown, secrets: ReadonlyArray<string>): unknown => {
  if (typeof value === "string") return scrubSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((entry) => scrubValue(entry, secrets));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, scrubValue(entry, secrets)]));
};

export const scrubEvent = (event: AgUiEvent, secrets: ReadonlyArray<string>) => {
  if (secrets.length === 0) return event;
  const scrubbed = Object.fromEntries(
    Object.entries(event).map(([key, value]) => [
      key,
      eventMetadataFields.has(key) ? value : scrubValue(value, secrets),
    ]),
  );
  return Schema.decodeUnknownSync(AgUiEvent)(scrubbed);
};

export const scrubHarnessError = (error: HarnessError, secrets: ReadonlyArray<string>) =>
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
export const satisfiedProjection = (): ChatMiddleware => ({
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
