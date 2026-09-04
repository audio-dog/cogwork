import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { isSupported as isSupportedRustRegex } from "@feojs/regex";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Schema from "effect/Schema";
import lockfile, { type LockOptions } from "proper-lockfile";
import { parse as parseToml, stringify as stringifyToml, TomlDate, type TomlPrimitive } from "smol-toml";

const isSupportedMatcher = (matcher: string) => matcher === "*" || isSupportedRustRegex(matcher);

const isTomlValue = (value: unknown): boolean => {
  if (value === null) return false;
  if (typeof value === "number") return !Number.isInteger(value) || Number.isSafeInteger(value);
  if (Array.isArray(value)) return value.every(isTomlValue);
  if (typeof value !== "object") return true;
  return Object.values(value).every(isTomlValue);
};

const Matcher = Schema.String.check(
  Schema.makeFilter(isSupportedMatcher, { expected: "a valid Codex Hook matcher" }),
);
const HooksFileJson = Schema.JsonObject.check(
  Schema.makeFilter((value) => Object.keys(value).every((key) => key === "description" || key === "hooks"), {
    expected: "a Codex Hooks file without unknown top-level fields",
  }),
);
const TomlJsonObject = Schema.JsonObject.check(
  Schema.makeFilter(isTomlValue, { expected: "JSON representable as TOML" }),
);

const CommandHook = Schema.Struct({
  type: Schema.Literal("command"),
  command: Schema.String,
  commandWindows: Schema.optional(Schema.String),
  command_windows: Schema.optional(Schema.String),
  timeout: Schema.optional(Schema.Natural),
  async: Schema.optional(Schema.Boolean),
  statusMessage: Schema.optional(Schema.String),
  additionalContextLimit: Schema.optional(Schema.Natural),
}).check(
  Schema.makeFilter(
    (handler) => handler.commandWindows === undefined || handler.command_windows === undefined,
    { expected: "at most one Windows command alias" },
  ),
);

const McpToolHook = Schema.Struct({
  type: Schema.Literal("mcp_tool"),
  server: Schema.String,
  tool: Schema.String,
  input: Schema.optional(TomlJsonObject),
  timeout: Schema.optional(Schema.Natural),
  statusMessage: Schema.optional(Schema.String),
});

const UnsupportedHook = Schema.Struct({ type: Schema.Literals(["prompt", "agent"]) });
const HookHandler = Schema.Union([CommandHook, McpToolHook, UnsupportedHook]);
const MatcherGroup = Schema.Struct({
  matcher: Schema.optional(Schema.String),
  hooks: Schema.optional(Schema.Array(HookHandler)),
});
const HookGroups = Schema.optional(Schema.Array(MatcherGroup));
const HookEvents = Schema.Struct({
  PreToolUse: HookGroups,
  PermissionRequest: HookGroups,
  PostToolUse: HookGroups,
  PreCompact: HookGroups,
  PostCompact: HookGroups,
  SessionStart: HookGroups,
  SessionEnd: HookGroups,
  UserPromptSubmit: HookGroups,
  SubagentStart: HookGroups,
  SubagentStop: HookGroups,
  Stop: HookGroups,
});
const HooksFile = Schema.Struct({
  description: Schema.optional(Schema.String),
  hooks: Schema.optional(HookEvents),
});

interface EventDefinition {
  readonly configName: keyof typeof HookEvents.Type;
  readonly keyName: string;
  readonly acceptsMatcher: boolean;
  readonly acceptsAdditionalContext: boolean;
}

const eventDefinitions = [
  {
    configName: "PreToolUse",
    keyName: "pre_tool_use",
    acceptsMatcher: true,
    acceptsAdditionalContext: true,
  },
  {
    configName: "PermissionRequest",
    keyName: "permission_request",
    acceptsMatcher: true,
    acceptsAdditionalContext: false,
  },
  {
    configName: "PostToolUse",
    keyName: "post_tool_use",
    acceptsMatcher: true,
    acceptsAdditionalContext: true,
  },
  {
    configName: "PreCompact",
    keyName: "pre_compact",
    acceptsMatcher: true,
    acceptsAdditionalContext: false,
  },
  {
    configName: "PostCompact",
    keyName: "post_compact",
    acceptsMatcher: true,
    acceptsAdditionalContext: false,
  },
  {
    configName: "SessionStart",
    keyName: "session_start",
    acceptsMatcher: true,
    acceptsAdditionalContext: true,
  },
  {
    configName: "SessionEnd",
    keyName: "session_end",
    acceptsMatcher: true,
    acceptsAdditionalContext: false,
  },
  {
    configName: "UserPromptSubmit",
    keyName: "user_prompt_submit",
    acceptsMatcher: false,
    acceptsAdditionalContext: true,
  },
  {
    configName: "SubagentStart",
    keyName: "subagent_start",
    acceptsMatcher: true,
    acceptsAdditionalContext: true,
  },
  {
    configName: "SubagentStop",
    keyName: "subagent_stop",
    acceptsMatcher: true,
    acceptsAdditionalContext: false,
  },
  { configName: "Stop", keyName: "stop", acceptsMatcher: false, acceptsAdditionalContext: false },
] satisfies ReadonlyArray<EventDefinition>;

export interface CodexHookTrustEntry {
  readonly key: string;
  readonly hash: string;
}

export class CodexHookTrustError extends Schema.TaggedError<CodexHookTrustError>()("CodexHookTrustError", {
  message: Schema.String,
}) {}

const defaultAdditionalContextLimit = 2_500;
const configLockOptions = {
  realpath: false,
  retries: { retries: 200, factor: 1, minTimeout: 50, maxTimeout: 50, randomize: true },
  stale: 5_000,
  update: 1_000,
} satisfies LockOptions;

const normalizedTimeout = (event: EventDefinition, timeout: number | undefined) => {
  if (event.configName !== "SessionEnd") return Math.max(timeout ?? 600, 1);
  return Math.min(Math.max(timeout ?? 1, 1), 3);
};

const matcherForEvent = (event: EventDefinition, matcher: string | undefined) => {
  if (!event.acceptsMatcher || matcher === undefined) return undefined;
  return Schema.decodeSync(Matcher)(matcher);
};

const normalizedCommand = (event: EventDefinition, handler: typeof CommandHook.Type) => ({
  type: handler.type,
  command:
    process.platform === "win32"
      ? (handler.commandWindows ?? handler.command_windows ?? handler.command)
      : handler.command,
  timeout: normalizedTimeout(event, handler.timeout),
  async: handler.async ?? false,
  ...(handler.statusMessage === undefined ? {} : { statusMessage: handler.statusMessage }),
  ...(event.acceptsAdditionalContext &&
  handler.additionalContextLimit !== undefined &&
  handler.additionalContextLimit !== defaultAdditionalContextLimit
    ? { additionalContextLimit: handler.additionalContextLimit }
    : {}),
});

const normalizedMcpTool = (handler: typeof McpToolHook.Type) => ({
  type: handler.type,
  server: handler.server,
  tool: handler.tool,
  input: handler.input ?? {},
  timeout: Math.max(handler.timeout ?? 600, 1),
  ...(handler.statusMessage === undefined ? {} : { statusMessage: handler.statusMessage }),
});

const normalizedHandler = (event: EventDefinition, handler: typeof HookHandler.Type) => {
  if (handler.type === "command") {
    if (handler.command.trim() === "") return null;
    return normalizedCommand(event, handler);
  }
  if (handler.type === "mcp_tool") {
    if (event.configName === "SessionEnd") return null;
    if (handler.server.trim() === "" || handler.tool.trim() === "") return null;
    return normalizedMcpTool(handler);
  }
  return null;
};

const canonicalJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
      .map(([key, entry]) => [key, canonicalJson(entry)]),
  );
};

const hookHash = (identity: unknown) =>
  `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalJson(identity)))
    .digest("hex")}`;

const entriesForEvent = (
  sourcePath: string,
  event: EventDefinition,
  groups: ReadonlyArray<typeof MatcherGroup.Type>,
) =>
  groups.flatMap((group, groupIndex) => {
    const matcher = matcherForEvent(event, group.matcher);
    return (group.hooks ?? []).flatMap((handler, handlerIndex) => {
      const normalized = normalizedHandler(event, handler);
      if (!normalized) return [];
      const identity = {
        event_name: event.keyName,
        ...(matcher === undefined ? {} : { matcher }),
        hooks: [normalized],
      };
      return [
        {
          key: `${sourcePath}:${event.keyName}:${groupIndex}:${handlerIndex}`,
          hash: hookHash(identity),
        },
      ];
    });
  });

export const codexHookTrustEntries = (sourcePath: string, contents: string) => {
  const json = Schema.decodeSync(Schema.fromJsonString(HooksFileJson))(contents);
  const parsed = Schema.decodeSync(HooksFile)(json);
  const hooks = parsed.hooks;
  if (!hooks) return [];
  return eventDefinitions.flatMap((event) =>
    entriesForEvent(sourcePath, event, hooks[event.configName] ?? []),
  );
};

type TomlTable = Record<string, TomlPrimitive>;

const HookState = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  trusted_hash: Schema.optional(Schema.String),
});

const HookStates = Schema.Record(Schema.String, HookState);

const isTomlTable = (value: unknown): value is TomlTable => {
  if (typeof value !== "object" || value === null || Array.isArray(value) || value instanceof TomlDate) {
    return false;
  }
  return true;
};

const asTomlTable = (value: unknown) => (isTomlTable(value) ? value : null);

const TomlTableSchema = Schema.declare<TomlTable>(isTomlTable, { identifier: "TOML table" });

const optionalTomlTable = (value: TomlPrimitive | undefined) => {
  if (value === undefined) return {};
  return Schema.decodeUnknownSync(TomlTableSchema)(value);
};

const parsedConfig = (contents: string) => {
  const config = parseToml(contents);
  const hooks = optionalTomlTable(config.hooks);
  const state = optionalTomlTable(hooks.state);
  const decodedState = Schema.decodeUnknownSync(HookStates)(state);
  return { config, hooks, state, decodedState };
};

const trustConfigUpdate = (contents: string, entries: ReadonlyArray<CodexHookTrustEntry>) => {
  const { config, hooks, state, decodedState } = parsedConfig(contents);
  const changed = entries.some((entry) => decodedState[entry.key]?.trusted_hash !== entry.hash);
  if (!changed) return { changed, contents };
  const updatedState: TomlTable = Object.fromEntries([
    ...Object.entries(state),
    ...entries.map((entry): [string, TomlTable] => [
      entry.key,
      { ...(asTomlTable(state[entry.key]) ?? {}), trusted_hash: entry.hash },
    ]),
  ]);
  return { changed, contents: stringifyToml({ ...config, hooks: { ...hooks, state: updatedState } }) };
};

export const upsertCodexHookTrust = (contents: string, entries: ReadonlyArray<CodexHookTrustEntry>) =>
  trustConfigUpdate(contents, entries).contents;

export const untrustedCodexHooks = (config: string, entries: ReadonlyArray<CodexHookTrustEntry>) => {
  const { decodedState } = parsedConfig(config);
  return entries
    .filter((entry) => {
      const state = decodedState[entry.key];
      return state?.enabled === false || state?.trusted_hash !== entry.hash;
    })
    .map(({ key }) => key);
};

const parseTrustEntries = (sourcePath: string, contents: string) =>
  Effect.try({
    try: () => codexHookTrustEntries(sourcePath, contents),
    catch: (cause) =>
      new CodexHookTrustError({
        message: `Cannot verify Codex Hooks in ${sourcePath}: ${String(cause)}`,
      }),
  });

const isNotFound = (error: PlatformError) => error.reason._tag === "NotFound";

const readConfig = (fs: FileSystem.FileSystem, configPath: string) =>
  fs.readFileString(configPath).pipe(Effect.catchIf(isNotFound, () => Effect.succeed("")));

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const configFailure = (action: string, configPath: string, cause: unknown) =>
  new CodexHookTrustError({
    message: `Cannot ${action} Codex Hook trust in ${configPath}: ${messageOf(cause)}`,
  });

const inspectConfig = (configPath: string, config: string, entries: ReadonlyArray<CodexHookTrustEntry>) =>
  Effect.try({
    try: () => untrustedCodexHooks(config, entries),
    catch: (cause) => configFailure("read", configPath, cause),
  });

const updateConfig = (configPath: string, config: string, entries: ReadonlyArray<CodexHookTrustEntry>) =>
  Effect.try({
    try: () => trustConfigUpdate(config, entries),
    catch: (cause) => configFailure("update", configPath, cause),
  });

const withConfigLock = <A, E, R>(configPath: string, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => lockfile.lock(configPath, configLockOptions),
      catch: (cause) => configFailure("lock", configPath, cause),
    }),
    () => effect,
    (release) =>
      Effect.tryPromise({
        try: () => release(),
        catch: (cause) => configFailure("unlock", configPath, cause),
      }),
  );

const replaceConfig = Effect.fn("CodexHookTrust.replaceConfig")(function* (
  fs: FileSystem.FileSystem,
  directory: string,
  configPath: string,
  contents: string,
) {
  const pendingPath = yield* fs.makeTempFileScoped({ directory, prefix: ".config.toml." });
  yield* fs.writeFileString(pendingPath, contents, { flag: "w", mode: 0o600 });
  yield* fs.chmod(pendingPath, 0o600);
  yield* fs.rename(pendingPath, configPath);
});

export const verifyCodexHookTrust = Effect.fn("CodexHookTrust.verify")(function* (
  sourcePath: string,
  configPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(sourcePath))) return;
  const entries = yield* fs
    .readFileString(sourcePath)
    .pipe(Effect.flatMap((contents) => parseTrustEntries(sourcePath, contents)));
  if (entries.length === 0) return;
  const config = yield* readConfig(fs, configPath);
  const untrusted = yield* inspectConfig(configPath, config, entries);
  if (untrusted.length === 0) return;
  return yield* new CodexHookTrustError({
    message: `Codex Hook is disabled or its trust is missing or stale: ${untrusted.join(", ")}`,
  });
});

export const writeCodexHookTrust = Effect.fn("CodexHookTrust.write")(function* (
  sourcePath: string,
  configPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!(yield* fs.exists(sourcePath))) return [];
  const normalizedSourcePath = yield* fs.realPath(sourcePath);
  const entries = yield* fs
    .readFileString(normalizedSourcePath)
    .pipe(Effect.flatMap((contents) => parseTrustEntries(normalizedSourcePath, contents)));
  if (entries.length === 0) return entries;
  const directory = path.dirname(configPath);
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
  return yield* withConfigLock(
    configPath,
    Effect.gen(function* () {
      const config = yield* readConfig(fs, configPath);
      const updated = yield* updateConfig(configPath, config, entries);
      if (!updated.changed) return entries;
      yield* replaceConfig(fs, directory, configPath, updated.contents).pipe(Effect.scoped);
      return entries;
    }),
  );
});
