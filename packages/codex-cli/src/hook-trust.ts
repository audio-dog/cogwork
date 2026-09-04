import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const CommandHook = Schema.Struct({
  type: Schema.Literal("command"),
  command: Schema.String,
  commandWindows: Schema.optional(Schema.String),
  command_windows: Schema.optional(Schema.String),
  timeout: Schema.optional(Schema.Natural),
  async: Schema.optional(Schema.Boolean),
  statusMessage: Schema.optional(Schema.String),
  additionalContextLimit: Schema.optional(Schema.Natural),
});

const McpToolHook = Schema.Struct({
  type: Schema.Literal("mcp_tool"),
  server: Schema.String,
  tool: Schema.String,
  input: Schema.optional(Schema.JsonObject),
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
const HooksFile = Schema.Struct({
  description: Schema.optional(Schema.String),
  hooks: Schema.Struct({
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
  }),
});

interface EventDefinition {
  readonly configName: keyof typeof HooksFile.Type.hooks;
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

const normalizedTimeout = (event: EventDefinition, timeout: number | undefined) => {
  if (event.configName !== "SessionEnd") return Math.max(timeout ?? 600, 1);
  return Math.min(Math.max(timeout ?? 1, 1), 3);
};

const exactMatcherPattern = /^[A-Za-z0-9_|]*$/;

const validMatcher = (matcher: string) => {
  if (matcher === "" || matcher === "*") return true;
  if (exactMatcherPattern.test(matcher)) return true;
  try {
    new RegExp(matcher);
    return true;
  } catch {
    return false;
  }
};

const matcherForEvent = (event: EventDefinition, matcher: string | undefined) =>
  event.acceptsMatcher ? matcher : undefined;

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
      .sort(([left], [right]) => left.localeCompare(right))
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
  groups.flatMap((group, groupIndex) =>
    !validMatcher(matcherForEvent(event, group.matcher) ?? "")
      ? []
      : (group.hooks ?? []).flatMap((handler, handlerIndex) => {
          const normalized = normalizedHandler(event, handler);
          if (!normalized) return [];
          const identity = {
            event_name: event.keyName,
            ...(matcherForEvent(event, group.matcher) === undefined
              ? {}
              : { matcher: matcherForEvent(event, group.matcher) }),
            hooks: [normalized],
          };
          return [
            {
              key: `${sourcePath}:${event.keyName}:${groupIndex}:${handlerIndex}`,
              hash: hookHash(identity),
            },
          ];
        }),
  );

export const codexHookTrustEntries = (sourcePath: string, contents: string) => {
  const parsed = Schema.decodeSync(Schema.fromJsonString(HooksFile))(contents);
  return eventDefinitions.flatMap((event) =>
    entriesForEvent(sourcePath, event, parsed.hooks[event.configName] ?? []),
  );
};

const tomlString = (value: string) => JSON.stringify(value);
const tableHeader = (key: string) => `[hooks.state.${tomlString(key)}]`;
const trustedHashLine = (hash: string) => `trusted_hash = ${tomlString(hash)}`;
const sectionEnd = (lines: ReadonlyArray<string>, start: number) => {
  const next = lines.findIndex((line, index) => index > start && /^\s*\[/.test(line));
  return next === -1 ? lines.length : next;
};

const upsertTrustEntry = (contents: string, entry: CodexHookTrustEntry) => {
  const lines = contents.split("\n");
  const start = lines.findIndex((line) => line.trim() === tableHeader(entry.key));
  if (start === -1) {
    const prefix = contents.length === 0 ? "" : `${contents.replace(/\n*$/, "")}\n\n`;
    return `${prefix}${tableHeader(entry.key)}\n${trustedHashLine(entry.hash)}\n`;
  }
  const end = sectionEnd(lines, start);
  const hashIndex = lines.findIndex(
    (line, index) => index > start && index < end && /^\s*trusted_hash\s*=/.test(line),
  );
  if (hashIndex === -1) {
    return [...lines.slice(0, start + 1), trustedHashLine(entry.hash), ...lines.slice(start + 1)].join("\n");
  }
  return lines.map((line, index) => (index === hashIndex ? trustedHashLine(entry.hash) : line)).join("\n");
};

export const upsertCodexHookTrust = (contents: string, entries: ReadonlyArray<CodexHookTrustEntry>) =>
  entries.reduce(upsertTrustEntry, contents);

const trustedHash = (contents: string, key: string) => {
  const lines = contents.split("\n");
  const start = lines.findIndex((line) => line.trim() === tableHeader(key));
  if (start === -1) return null;
  const end = sectionEnd(lines, start);
  const match = lines
    .slice(start + 1, end)
    .map((line) => /^\s*trusted_hash\s*=\s*"([^"]+)"\s*$/.exec(line))
    .find((candidate) => candidate !== null);
  return match?.[1] ?? null;
};

export const untrustedCodexHooks = (config: string, entries: ReadonlyArray<CodexHookTrustEntry>) =>
  entries.filter((entry) => trustedHash(config, entry.key) !== entry.hash).map(({ key }) => key);

const parseTrustEntries = (sourcePath: string, contents: string) =>
  Effect.try({
    try: () => codexHookTrustEntries(sourcePath, contents),
    catch: (cause) =>
      new CodexHookTrustError({
        message: `Cannot verify Codex Hooks in ${sourcePath}: ${String(cause)}`,
      }),
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
  const config = yield* fs.readFileString(configPath).pipe(Effect.orElseSucceed(() => ""));
  const untrusted = untrustedCodexHooks(config, entries);
  if (untrusted.length === 0) return;
  return yield* new CodexHookTrustError({
    message: `Codex Hook trust is missing or stale: ${untrusted.join(", ")}`,
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
  const config = yield* fs.readFileString(configPath).pipe(Effect.orElseSucceed(() => ""));
  const updated = upsertCodexHookTrust(config, entries);
  if (updated === config) return entries;
  yield* fs.makeDirectory(path.dirname(configPath), { recursive: true, mode: 0o700 });
  yield* fs.writeFileString(configPath, updated);
  yield* fs.chmod(configPath, 0o600);
  return entries;
});
