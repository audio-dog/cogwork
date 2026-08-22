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
  readonly resolveGitMetadataDirectory?: ResolveGitMetadataDirectory;
}

export type MakeCodexAdapter = (model: CodexModel, config: CodexTextConfig) => CodexTextAdapter<CodexModel>;

export type ResolveGitMetadataDirectory = (checkoutPath: string) => Effect.Effect<string | null>;

export interface CodexRunChatOptions {
  readonly adapter: CodexTextAdapter<CodexModel>;
  readonly messages: ReadonlyArray<ModelMessage>;
  readonly systemPrompts: ReadonlyArray<string>;
  readonly middleware: ReadonlyArray<ChatMiddleware>;
  readonly abortController: AbortController;
  readonly modelOptions: CodexTextProviderOptions;
  readonly outputSchema?: Harness.StageResultSchema;
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
    outputSchema: options.outputSchema,
    stream: true,
  });

export const codexRuntimeConfig = (effort: CodexEffort): CodexTextConfig => ({
  approvalPolicy: "never",
  sandboxMode: "danger-full-access",
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

const missingExecutablePattern = /ENOENT|EACCES|command not found/i;
const missingLoginPattern = /codex login|not (?:logged|signed) in/i;

const classifyTurnError = (error: Harness.HarnessError) => {
  if (missingExecutablePattern.test(error.message)) {
    return launchError(
      `Codex CLI could not start. Install Codex CLI, then run \`codex login\`. (${error.message})`,
    );
  }
  if (missingLoginPattern.test(error.message)) {
    return launchError(`Codex CLI is not authenticated. Run \`codex login\`, then retry. (${error.message})`);
  }
  return error;
};

const codexEfforts: ReadonlyArray<CodexEffort> = ["minimal", "low", "medium", "high"];

const gitMetadataDirectory = (checkoutPath: string) =>
  Effect.scoped(
    Effect.acquireRelease(
      Effect.promise(() => localProcessSandbox({ dir: checkoutPath }).create({})),
      (sandbox) => Effect.promise(() => sandbox.destroy()),
    ).pipe(
      Effect.flatMap((sandbox) =>
        Effect.promise(() => sandbox.process.exec("git rev-parse --path-format=absolute --git-common-dir")),
      ),
      Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : null)),
      Effect.orElseSucceed(() => null),
    ),
  );

const decodeEffort = (effort: string): CodexEffort | null =>
  codexEfforts.find((candidate) => candidate === effort) ?? null;

const resolveEffort = (requested: string | null, fallback: CodexEffort) => {
  const configured = requested ?? fallback;
  const effort = decodeEffort(configured);
  if (effort) return Effect.succeed(effort);
  return Effect.fail(launchError(`unsupported Codex reasoning effort: ${configured}`));
};

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

const mcpServerIdentity = (name: string, index: number) =>
  `cogwork_mcp_${Array.from(name, (character) => character.codePointAt(0)?.toString(16) ?? "").join("_")}_${index}`;

const mcpEnvName = (identity: string) => `${identity.toUpperCase()}_BEARER`;

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

const mcpEntries = (skill: Harness.ResolvedMcpSkill, index: number) => {
  const identity = mcpServerIdentity(skill.name, index);
  const prefix = `mcp_servers.${identity}`;
  const envName = mcpEnvName(identity);
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
  gitDirectory: string | null,
): CodexTextConfig => ({
  ...codexRuntimeConfig(effort),
  ...(codexExecutable ? { codexExecutable } : {}),
  ...(gitDirectory ? { additionalDirectories: [gitDirectory] } : {}),
  ...mcpAdapterConfig(mcpSkills),
});

export const codexRunner = (options: CodexRunnerOptions): Harness.HarnessRunner => {
  const makeAdapter = options.makeAdapter ?? codexText;
  const runChat = options.runChat ?? defaultRunChat;
  const resolveGitMetadataDirectory = options.resolveGitMetadataDirectory ?? gitMetadataDirectory;

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
          const gitDirectory = yield* resolveGitMetadataDirectory(request.checkoutPath);
          const adapter = makeAdapter(
            model,
            adapterConfig(effort, options.codexExecutable, request.mcpSkills, gitDirectory),
          );
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
            outputSchema: Harness.stageResultSchema(request.stage),
          });
          return HarnessBridge.bridgeChat(stream).pipe(
            Stream.mapError(classifyTurnError),
            Stream.ensuring(Effect.sync(() => abortController.abort())),
          );
        }),
      ),
  };
};
