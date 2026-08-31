import { toolDefinition } from "@tanstack/ai";
import type { SandboxHandle, SandboxPolicy } from "@tanstack/ai-sandbox";
import * as Effect from "effect/Effect";
import type * as FiberSet from "effect/FiberSet";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { confine } from "./confinement";
import { type ToolError, toolError } from "./errors";
import {
  denyReason,
  gateDecision,
  type OwnedToolName,
  type PolicyDenied,
  policyDenied,
  readOnlyProfile,
} from "./policy";
import type { WorktreeSandbox } from "./sandbox";

const IGNORED_DIRS = new Set([".git", "node_modules"]);
const MAX_MATCHES = 1000;

const standardSchema = <S extends Schema.Codec<unknown, unknown, never, never>>(schema: S) =>
  Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(schema));

const readFailure = (path: string, cause: unknown): ToolError => {
  const message = String(cause);
  const reason = /ENOENT|no such file/i.test(message) ? "not-found" : "read-failed";
  return toolError(reason, message, path);
};

const globToken = (
  globstarSlash: string,
  globstar: string,
  star: string,
  question: string,
  special: string,
) => {
  if (globstarSlash) return "(?:.*/)?";
  if (globstar) return ".*";
  if (star) return "[^/]*";
  if (question) return "[^/]";
  return `\\${special}`;
};

const globToRegExp = (glob: string): RegExp => {
  const source = glob.replace(
    /(\*\*\/)|(\*\*)|(\*)|(\?)|([.+^${}()|[\]\\])/g,
    (_match, globstarSlash, globstar, star, question, special) =>
      globToken(globstarSlash, globstar, star, question, special),
  );
  return new RegExp(`^${source}$`);
};

const relativeTo = (base: string, path: string) => (base === "" ? path : path.slice(base.length + 1));

const listFiles = (handle: SandboxHandle, dir: string): Effect.Effect<ReadonlyArray<string>, ToolError> =>
  Effect.gen(function* () {
    const entries = yield* Effect.tryPromise({
      try: () => handle.fs.list(dir === "" ? "." : dir),
      catch: (cause) => readFailure(dir, cause),
    });
    const nested = yield* Effect.forEach(
      entries.filter((entry) => !IGNORED_DIRS.has(entry.name)),
      (entry) => {
        const childRel = dir === "" ? entry.name : `${dir}/${entry.name}`;
        return entry.type === "dir"
          ? listFiles(handle, childRel)
          : Effect.succeed<ReadonlyArray<string>>([childRel]);
      },
    );
    return nested.flat();
  });

export const ReadArgs = Schema.Struct({
  path: Schema.String,
  offset: Schema.optional(Schema.Natural),
  limit: Schema.optional(Schema.Natural),
});
export type ReadArgs = typeof ReadArgs.Type;

export const readFile = Effect.fn("Tools.read")(function* (sandbox: WorktreeSandbox, args: ReadArgs) {
  const rel = yield* confine(args.path);
  const content = yield* Effect.tryPromise({
    try: () => sandbox.handle.fs.read(rel),
    catch: (cause) => readFailure(rel, cause),
  });
  if (args.offset === undefined && args.limit === undefined) {
    return { path: rel, content };
  }
  const lines = content.split("\n");
  const start = args.offset ?? 0;
  const end = args.limit === undefined ? lines.length : start + args.limit;
  return { path: rel, content: lines.slice(start, end).join("\n") };
});

export const WriteArgs = Schema.Struct({
  path: Schema.String,
  content: Schema.String,
});
export type WriteArgs = typeof WriteArgs.Type;

export const writeFile = Effect.fn("Tools.write")(function* (sandbox: WorktreeSandbox, args: WriteArgs) {
  const rel = yield* confine(args.path);
  yield* Effect.tryPromise({
    try: () => sandbox.handle.fs.write(rel, args.content),
    catch: (cause) => toolError("write-failed", String(cause), rel),
  });
  return { path: rel, bytesWritten: new TextEncoder().encode(args.content).length };
});

export const EditArgs = Schema.Struct({
  path: Schema.String,
  oldString: Schema.String,
  newString: Schema.String,
  replaceAll: Schema.optional(Schema.Boolean),
});
export type EditArgs = typeof EditArgs.Type;

export const editFile = Effect.fn("Tools.edit")(function* (sandbox: WorktreeSandbox, args: EditArgs) {
  const rel = yield* confine(args.path);
  const content = yield* Effect.tryPromise({
    try: () => sandbox.handle.fs.read(rel),
    catch: (cause) => readFailure(rel, cause),
  });
  const occurrences = content.split(args.oldString).length - 1;
  if (occurrences === 0) {
    return yield* toolError("edit-no-match", `oldString not found in ${rel}`, rel);
  }
  if (occurrences > 1 && args.replaceAll !== true) {
    return yield* toolError("edit-ambiguous", `oldString matches ${occurrences} times in ${rel}`, rel);
  }
  const next =
    args.replaceAll === true
      ? content.split(args.oldString).join(args.newString)
      : replaceFirst(content, args.oldString, args.newString);
  yield* Effect.tryPromise({
    try: () => sandbox.handle.fs.write(rel, next),
    catch: (cause) => toolError("write-failed", String(cause), rel),
  });
  return { path: rel, replacements: args.replaceAll === true ? occurrences : 1 };
});

const replaceFirst = (content: string, oldString: string, newString: string) => {
  const index = content.indexOf(oldString);
  return content.slice(0, index) + newString + content.slice(index + oldString.length);
};

export const BashArgs = Schema.Struct({
  command: Schema.String,
  cwd: Schema.optional(Schema.String),
});
export type BashArgs = typeof BashArgs.Type;

export const runBash = Effect.fn("Tools.bash")(function* (sandbox: WorktreeSandbox, args: BashArgs) {
  const cwd = args.cwd === undefined ? undefined : yield* confine(args.cwd);
  return yield* Effect.tryPromise({
    try: (signal) =>
      sandbox.handle.process.exec(args.command, {
        ...(cwd ? { cwd } : {}),
        signal,
      }),
    catch: (cause) => toolError("exec-failed", String(cause), cwd ?? null),
  }).pipe(
    Effect.map((result) => ({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    })),
  );
});

export const GlobArgs = Schema.Struct({
  pattern: Schema.String,
  path: Schema.optional(Schema.String),
});
export type GlobArgs = typeof GlobArgs.Type;

export const runGlob = Effect.fn("Tools.glob")(function* (sandbox: WorktreeSandbox, args: GlobArgs) {
  const base = args.path === undefined ? "" : yield* confine(args.path);
  const files = yield* listFiles(sandbox.handle, base);
  const matcher = globToRegExp(args.pattern);
  const matches = files.filter((file) => matcher.test(relativeTo(base, file))).slice(0, MAX_MATCHES);
  return { matches };
});

export const GrepArgs = Schema.Struct({
  pattern: Schema.String,
  path: Schema.optional(Schema.String),
  include: Schema.optional(Schema.String),
});
export type GrepArgs = typeof GrepArgs.Type;

interface GrepMatch {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

export const runGrep = Effect.fn("Tools.grep")(function* (sandbox: WorktreeSandbox, args: GrepArgs) {
  const regexp = yield* compileRegExp(args.pattern);
  const base = args.path === undefined ? "" : yield* confine(args.path);
  const includeMatcher = args.include === undefined ? null : globToRegExp(args.include);
  const files = (yield* listFiles(sandbox.handle, base)).filter(
    (file) => includeMatcher === null || includeMatcher.test(relativeTo(base, file)),
  );
  const perFile = yield* Effect.forEach(files, (file) =>
    Effect.gen(function* () {
      const content = yield* Effect.tryPromise({
        try: () => sandbox.handle.fs.read(file),
        catch: (cause) => readFailure(file, cause),
      });
      return content
        .split("\n")
        .flatMap(
          (text, index): ReadonlyArray<GrepMatch> =>
            regexp.test(text) ? [{ path: file, line: index + 1, text }] : [],
        );
    }),
  );
  return { matches: perFile.flat().slice(0, MAX_MATCHES) };
});

const compileRegExp = (pattern: string): Effect.Effect<RegExp, ToolError> =>
  Effect.try({
    try: () => new RegExp(pattern),
    catch: (cause) => toolError("invalid-args", `invalid grep pattern: ${String(cause)}`),
  });

export const WebFetchArgs = Schema.Struct({
  url: Schema.String,
});
export type WebFetchArgs = typeof WebFetchArgs.Type;

export const webFetch = Effect.fn("Tools.webfetch")(function* (
  _sandbox: WorktreeSandbox,
  args: WebFetchArgs,
) {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client
    .get(args.url)
    .pipe(Effect.mapError((cause) => toolError("fetch-failed", cause.message)));
  const content = yield* response.text.pipe(
    Effect.mapError((cause) => toolError("fetch-failed", cause.message)),
  );
  return { url: args.url, status: response.status, content };
});

type ToolRunPromise = Effect.Success<ReturnType<typeof FiberSet.makeRuntimePromise<HttpClient.HttpClient>>>;

const bindServer =
  <S extends Schema.Codec<unknown, unknown, never, never>>(
    sandbox: WorktreeSandbox,
    runPromise: ToolRunPromise,
    profile: SandboxPolicy,
    tool: OwnedToolName,
    schema: S,
    extractCommand?: (args: S["Type"]) => string,
  ) =>
  <A>(
    handler: (
      sandbox: WorktreeSandbox,
      args: S["Type"],
    ) => Effect.Effect<A, ToolError, HttpClient.HttpClient>,
  ) => {
    const decode = Schema.decodeUnknownEffect(schema);
    return (args: unknown): Promise<A | PolicyDenied> =>
      runPromise(
        decode(args).pipe(
          Effect.mapError((issue) => toolError("invalid-args", String(issue))),
          Effect.flatMap(
            (decoded): Effect.Effect<A | PolicyDenied, ToolError, HttpClient.HttpClient> =>
              gateDecision(profile, tool, extractCommand?.(decoded)) === "deny"
                ? Effect.succeed(policyDenied(tool, denyReason(tool)))
                : handler(sandbox, decoded),
          ),
        ),
      );
  };

export const ownedToolNames = ["read", "write", "edit", "bash", "glob", "grep", "webfetch"] as const;

export const makeOwnedToolSet = (
  sandbox: WorktreeSandbox,
  runPromise: ToolRunPromise,
  profile: SandboxPolicy = readOnlyProfile,
) => ({
  read: toolDefinition({
    name: "read",
    description: "Read a file from the worktree. Optionally slice by line offset and limit.",
    inputSchema: standardSchema(ReadArgs),
  }).server(bindServer(sandbox, runPromise, profile, "read", ReadArgs)(readFile)),
  write: toolDefinition({
    name: "write",
    description: "Write a file in the worktree, creating parent directories as needed.",
    inputSchema: standardSchema(WriteArgs),
  }).server(bindServer(sandbox, runPromise, profile, "write", WriteArgs)(writeFile)),
  edit: toolDefinition({
    name: "edit",
    description:
      "Replace an exact string in a worktree file. Fails when the string is missing or ambiguous unless replaceAll is set.",
    inputSchema: standardSchema(EditArgs),
  }).server(bindServer(sandbox, runPromise, profile, "edit", EditArgs)(editFile)),
  bash: toolDefinition({
    name: "bash",
    description: "Run a shell command in the worktree and capture stdout, stderr, and exit code.",
    inputSchema: standardSchema(BashArgs),
  }).server(bindServer(sandbox, runPromise, profile, "bash", BashArgs, (args) => args.command)(runBash)),
  glob: toolDefinition({
    name: "glob",
    description: "List worktree files matching a glob pattern.",
    inputSchema: standardSchema(GlobArgs),
  }).server(bindServer(sandbox, runPromise, profile, "glob", GlobArgs)(runGlob)),
  grep: toolDefinition({
    name: "grep",
    description: "Search worktree file contents for a regular expression, line by line.",
    inputSchema: standardSchema(GrepArgs),
  }).server(bindServer(sandbox, runPromise, profile, "grep", GrepArgs)(runGrep)),
  webfetch: toolDefinition({
    name: "webfetch",
    description: "Fetch a URL over the network and return its text body.",
    inputSchema: standardSchema(WebFetchArgs),
  }).server(bindServer(sandbox, runPromise, profile, "webfetch", WebFetchArgs)(webFetch)),
});

export type OwnedToolSet = ReturnType<typeof makeOwnedToolSet>;
