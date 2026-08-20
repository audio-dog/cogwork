import type { HarnessName } from "@cogwork/contracts";
import { ContextAssembler, Harness, HarnessBridge, SessionStore } from "@cogwork/engine";
import { type ChatMiddleware, chat, type ModelMessage, type StreamChunk } from "@tanstack/ai";
import {
  type CodexModel,
  type CodexTextAdapter,
  type CodexTextConfig,
  type CodexTextProviderOptions,
  codexText,
} from "@tanstack/ai-codex";
import { defineSandbox, defineWorkspace, withSandbox } from "@tanstack/ai-sandbox";
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";

export type CodexEffort = NonNullable<CodexTextConfig["modelReasoningEffort"]>;

export interface CodexRunnerOptions {
  readonly name: HarnessName;
  readonly codexExecutable?: string;
  readonly makeAdapter?: MakeCodexAdapter;
  readonly runChat?: CodexRunChat;
}

export type MakeCodexAdapter = (model: CodexModel, config: CodexTextConfig) => CodexTextAdapter<CodexModel>;

export interface CodexRunChatOptions {
  readonly adapter: CodexTextAdapter<CodexModel>;
  readonly messages: ReadonlyArray<ModelMessage>;
  readonly systemPrompts: ReadonlyArray<string>;
  readonly middleware: ReadonlyArray<ChatMiddleware>;
  readonly abortController: AbortController;
  readonly modelOptions: CodexTextProviderOptions;
}

export type CodexRunChat = (options: CodexRunChatOptions) => AsyncIterable<StreamChunk>;

const defaultRunChat: CodexRunChat = (options) =>
  chat({
    adapter: options.adapter,
    messages: [...options.messages],
    systemPrompts: [...options.systemPrompts],
    middleware: [...options.middleware],
    abortController: options.abortController,
    modelOptions: options.modelOptions,
  });

export const codexRuntimeConfig = (effort: CodexEffort): CodexTextConfig => ({
  approvalPolicy: "never",
  sandboxMode: "workspace-write",
  networkAccessEnabled: true,
  modelReasoningEffort: effort,
});

export const renderContext = (assembled: ContextAssembler.AssembledContext) => [
  ...assembled.layers.map((layer) => layer.content),
  `Mandatory playbook resources: ${assembled.skillPath}`,
];

export const codexModelOptions = (handle: string | null, effort: CodexEffort): CodexTextProviderOptions => ({
  ...(handle ? { sessionId: handle } : {}),
  modelReasoningEffort: effort,
});

const launchError = (message: string) =>
  new Harness.HarnessError({ reason: "launch", retryable: false, message });

const launchFailurePattern =
  /ENOENT|EACCES|command not found|codex login|not logged in|authentication|unauthorized|401/i;

const classifyTurnError = (error: Harness.HarnessError) =>
  launchFailurePattern.test(error.message) ? launchError(error.message) : error;

const codexEfforts: ReadonlyArray<CodexEffort> = ["minimal", "low", "medium", "high"];

const decodeEffort = (effort: string): CodexEffort | null =>
  codexEfforts.find((candidate) => candidate === effort) ?? null;

const resolveEffort = (requested: string | null, fallback: CodexEffort) => {
  const configured = requested ?? fallback;
  const effort = decodeEffort(configured);
  if (effort) return Effect.succeed(effort);
  return Effect.fail(launchError(`unsupported Codex reasoning effort: ${configured}`));
};

const mcpNamePattern = /^[A-Za-z0-9_-]+$/;

const codexEnvironmentNames = [
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
];

export const codexChildEnvironment = (environment: NodeJS.ProcessEnv = process.env) =>
  Object.fromEntries(
    codexEnvironmentNames.flatMap((name) => {
      const value = environment[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );

const validateMcpSkill = (skill: Harness.ResolvedMcpSkill) =>
  mcpNamePattern.test(skill.name)
    ? Effect.succeed(skill)
    : Effect.fail(launchError(`unsupported Codex MCP skill name: ${skill.name}`));

const mcpEnvName = (name: string) =>
  `COGWORK_MCP_${Array.from(name, (character) => character.charCodeAt(0).toString(16)).join("")}`;

const mcpBearerEntries = (prefix: string, envName: string, bearer: Harness.ResolvedMcpSkill["bearer"]) => {
  if (!bearer) return { configEntries: [], envEntries: [] };
  return {
    configEntries: [[`${prefix}.bearer_token_env_var`, JSON.stringify(envName)]],
    envEntries: [[envName, Redacted.value(bearer)]],
  } satisfies {
    readonly configEntries: ReadonlyArray<readonly [string, string]>;
    readonly envEntries: ReadonlyArray<readonly [string, string]>;
  };
};

const mcpEntries = (skill: Harness.ResolvedMcpSkill) => {
  const prefix = `mcp_servers.${skill.name}`;
  const envName = mcpEnvName(skill.name);
  const bearer = mcpBearerEntries(prefix, envName, skill.bearer);
  const configEntries: ReadonlyArray<readonly [string, string]> = [
    [`${prefix}.url`, JSON.stringify(skill.endpoint)],
    ...bearer.configEntries,
  ];
  return { configEntries, envEntries: bearer.envEntries };
};

const mcpAdapterConfig = (mcpSkills: ReadonlyArray<Harness.ResolvedMcpSkill>) => {
  const entries = mcpSkills.map(mcpEntries);
  return {
    ...(entries.length > 0
      ? { config: Object.fromEntries(entries.flatMap((entry) => entry.configEntries)) }
      : {}),
    env: {
      ...codexChildEnvironment(),
      ...Object.fromEntries(entries.flatMap((entry) => entry.envEntries)),
    },
  };
};

const adapterConfig = (
  effort: CodexEffort,
  codexExecutable: string | undefined,
  mcpSkills: ReadonlyArray<Harness.ResolvedMcpSkill>,
): CodexTextConfig => ({
  ...codexRuntimeConfig(effort),
  ...(codexExecutable ? { codexExecutable } : {}),
  ...mcpAdapterConfig(mcpSkills),
});

export const codexRunner = (options: CodexRunnerOptions): Harness.HarnessRunner => {
  const makeAdapter = options.makeAdapter ?? codexText;
  const runChat = options.runChat ?? defaultRunChat;

  return {
    name: options.name,
    sessionKind: "opaque-handle",
    run: (request) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const effort = yield* resolveEffort(request.effort, "high");
          const assembler = yield* ContextAssembler.ContextAssembler;
          const assembled = yield* assembler
            .assemble({
              cwd: request.checkoutPath,
              projectRoot: request.checkoutPath,
              skill: request.skill,
            })
            .pipe(Effect.mapError((error) => launchError(error.message)));
          const store = yield* SessionStore.SessionStore;
          const handle = request.session ? yield* store.resumeHandle(request.session) : null;
          const model = request.model ?? "gpt-5.6-sol";
          const mcpSkills = yield* Effect.forEach(request.mcpSkills, validateMcpSkill);
          const adapter = makeAdapter(model, adapterConfig(effort, options.codexExecutable, mcpSkills));
          const sandbox = defineSandbox({
            id: `cogwork-${options.name}`,
            fileEvents: false,
            provider: localProcessSandbox({
              dir: request.checkoutPath,
              scrubEnv: ["GITHUB_TOKEN", "GH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY"],
            }),
            workspace: defineWorkspace({ source: { type: "none" } }),
          });
          const abortController = new AbortController();
          const stream = runChat({
            adapter,
            messages: [{ role: "user", content: request.prompt }],
            systemPrompts: renderContext(assembled),
            middleware: [withSandbox(sandbox)],
            abortController,
            modelOptions: codexModelOptions(handle, effort),
          });
          return HarnessBridge.bridgeChat(stream).pipe(
            Stream.mapError(classifyTurnError),
            Stream.ensuring(Effect.sync(() => abortController.abort())),
          );
        }),
      ),
  };
};
