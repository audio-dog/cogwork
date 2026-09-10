import { toolDefinition } from "@tanstack/ai";
import type { SandboxPolicy, SpawnHandle } from "@tanstack/ai-sandbox";
import { rgPath } from "@vscode/ripgrep";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as FiberSet from "effect/FiberSet";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import createIgnore, { type Ignore } from "ignore";
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

const MAX_MATCHES = 1000;
const searchDeadline = "30 seconds";
const processReleaseDeadline = "1 second";
const stderrMaxBytes = 64 * 1024;
const jsonRecordMaxBytes = 1024 * 1024;
const bashDeadline = "5 minutes";
const webFetchDeadline = "30 seconds";

const standardSchema = <S extends Schema.Codec<unknown, unknown, never, never>>(schema: S) =>
  Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(schema));

const readFailure = (path: string, cause: unknown): ToolError => {
  const message = String(cause);
  const reason =
    typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT"
      ? "not-found"
      : "read-failed";
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

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const searchCommand = (args: ReadonlyArray<string>) => [rgPath, ...args].map(shellQuote).join(" ");

const relativeSearchPath = (path: string) => (path.startsWith("./") ? path.slice(2) : path);

const pathWithinBase = (base: string, path: string) => {
  const relative = relativeSearchPath(path);
  if (base === "") return relative;
  if (!relative.startsWith(`${base}/`)) return null;
  return relative.slice(base.length + 1);
};

const searchTarget = (base: string) => (base === "" ? "." : base);

const searchArgs = ["--hidden", "--no-config", "--no-follow", "--path-separator=/"];

const searchExclusions = [
  "--glob=!.git",
  "--glob=!.git/**",
  "--glob=!node_modules",
  "--glob=!node_modules/**",
];
const searchIgnoreFiles = [".gitignore", ".ignore", ".rgignore"];

const processFailure = (cause: unknown) =>
  toolError("exec-failed", `search process failed: ${String(cause)}`);

const processCommand = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: processFailure,
  });

const pathPrefixes = (path: string) =>
  path.split("/").map((_segment, index, segments) => segments.slice(0, index + 1).join("/"));

const validateSearchBase = Effect.fn("Tools.search.validateBase")(function* (
  sandbox: WorktreeSandbox,
  base: string,
) {
  if (base === "") return;
  const exists = yield* Effect.tryPromise({
    try: () => sandbox.handle.fs.exists(base),
    catch: (cause) => readFailure(base, cause),
  });
  if (!exists) return yield* toolError("not-found", `search path not found: ${base}`, base);
  const lstat = sandbox.handle.fs.lstat;
  if (lstat === undefined) return;
  yield* Effect.forEach(pathPrefixes(base), (path) =>
    Effect.tryPromise({
      try: () => lstat(path),
      catch: (cause) => readFailure(path, cause),
    }).pipe(
      Effect.flatMap((stat) => {
        if (stat === undefined) {
          return Effect.fail(toolError("not-found", `search path not found: ${base}`, base));
        }
        if (stat.type === "symlink") {
          return Effect.fail(
            toolError("out-of-bounds", `search path contains a symbolic link: ${path}`, path),
          );
        }
        return Effect.void;
      }),
    ),
  );
});

const readSearchIgnoreFile = Effect.fn("Tools.search.readIgnoreFile")(function* (
  sandbox: WorktreeSandbox,
  path: string,
) {
  const exists = yield* Effect.tryPromise({
    try: () => sandbox.handle.fs.exists(path),
    catch: (cause) => readFailure(path, cause),
  });
  if (!exists) return "";
  return yield* Effect.tryPromise({
    try: () => sandbox.handle.fs.read(path),
    catch: (cause) => readFailure(path, cause),
  });
});

const loadSearchIgnore = Effect.fn("Tools.search.loadIgnore")(function* (
  sandbox: WorktreeSandbox,
  base: string,
) {
  const contents = yield* Effect.forEach(searchIgnoreFiles, (name) =>
    readSearchIgnoreFile(sandbox, base === "" ? name : `${base}/${name}`),
  );
  return { base, matcher: createIgnore().add(contents) };
});

const searchIgnoreDecision = (
  scopes: ReadonlyArray<{ readonly base: string; readonly matcher: Ignore }>,
  path: string,
) =>
  scopes.reduce<boolean | null>((decision, scope) => {
    const relative = scope.base === "" ? path : path.slice(scope.base.length + 1);
    const result = scope.matcher.test(`${relative}/`);
    if (result.ignored) return true;
    if (result.unignored) return false;
    return decision;
  }, null);

const isGitIgnored = Effect.fn("Tools.search.isGitIgnored")(function* (
  sandbox: WorktreeSandbox,
  path: string,
) {
  const result = yield* Effect.tryPromise({
    try: (signal) =>
      sandbox.handle.process.exec(`git check-ignore --no-index -q -- ${shellQuote(path)}`, { signal }),
    catch: processFailure,
  }).pipe(
    Effect.timeoutOrElse({
      duration: searchDeadline,
      orElse: () => Effect.fail(toolError("timeout", `search timed out after ${searchDeadline}`, path)),
    }),
  );
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  return yield* toolError(
    "exec-failed",
    `search ignore check exited ${result.exitCode}: ${result.stderr.trim()}`,
    path,
  );
});

const isSearchBaseIgnored = Effect.fn("Tools.search.isBaseIgnored")(function* (
  sandbox: WorktreeSandbox,
  base: string,
) {
  const segments = base.split("/");
  const rootScope = yield* loadSearchIgnore(sandbox, "");
  const result = yield* Effect.reduce(
    segments,
    () => ({ ignored: false, scopes: [rootScope] }),
    (state, _segment, index) =>
      Effect.gen(function* () {
        if (state.ignored) return state;
        const path = segments.slice(0, index + 1).join("/");
        const decision = searchIgnoreDecision(state.scopes, path);
        const ignored = decision ?? (yield* isGitIgnored(sandbox, path));
        if (ignored || index === segments.length - 1) return { ...state, ignored };
        const scope = yield* loadSearchIgnore(sandbox, path);
        return { ignored: false, scopes: state.scopes.concat(scope) };
      }),
  );
  return result.ignored;
});

const prepareSearchBase = Effect.fn("Tools.search.prepareBase")(function* (
  sandbox: WorktreeSandbox,
  base: string,
) {
  yield* validateSearchBase(sandbox, base);
  if (base === "") return false;
  return yield* isSearchBaseIgnored(sandbox, base);
});

interface SearchProcess {
  readonly process: SpawnHandle;
  readonly completed: Deferred.Deferred<void>;
  readonly exit: Promise<number>;
}

const signalSearchProcess = (running: SearchProcess, signal: NodeJS.Signals) =>
  processCommand(() => running.process.kill(signal)).pipe(
    Effect.ignore,
    Effect.andThen(processCommand(() => running.exit).pipe(Effect.interruptible)),
  );

const terminateSearchProcess = (running: SearchProcess) =>
  signalSearchProcess(running, "SIGTERM").pipe(
    Effect.timeoutOrElse({
      duration: processReleaseDeadline,
      orElse: () =>
        signalSearchProcess(running, "SIGKILL").pipe(Effect.timeout(processReleaseDeadline), Effect.ignore),
    }),
    Effect.ignore,
  );

const stopSearchProcess = (running: SearchProcess) =>
  Deferred.isDone(running.completed).pipe(
    Effect.flatMap((completed) => (completed ? Effect.void : terminateSearchProcess(running))),
  );

const startSearchProcess = Effect.fn("Tools.search.start")(function* (
  sandbox: WorktreeSandbox,
  command: string,
) {
  const process = yield* Effect.tryPromise({
    try: (signal) => sandbox.handle.process.spawn(command, { signal }),
    catch: processFailure,
  });
  const completed = yield* Deferred.make<void>();
  return { process, completed, exit: process.wait() };
});

const acquireSearchProcess = (sandbox: WorktreeSandbox, command: string) =>
  Effect.acquireRelease(startSearchProcess(sandbox, command), stopSearchProcess, {
    interruptible: true,
  });

const processStream = (chunks: AsyncIterable<string>) => Stream.fromAsyncIterable(chunks, processFailure);

const collectStderr = (chunks: AsyncIterable<string>) =>
  processStream(chunks).pipe(
    Stream.runFold(
      () => "",
      (output, chunk) => `${output}${chunk}`.slice(0, stderrMaxBytes),
    ),
  );

interface CollectedOutput<A> {
  readonly matches: ReadonlyArray<A>;
  readonly buffered: string;
}

const splitRecords = (buffered: string, next: IteratorResult<string>, separator: string) => {
  const records = `${buffered}${next.done ? "" : next.value}`.split(separator);
  if (next.done || records.at(-1) === "") return { buffered: "", records };
  return { buffered: records.at(-1) ?? "", records: records.slice(0, -1) };
};

const collectRecords = <A>(
  records: ReadonlyArray<string>,
  parse: (record: string) => Effect.Effect<A | null, ToolError>,
  matches: ReadonlyArray<A>,
  index = 0,
): Effect.Effect<ReadonlyArray<A>, ToolError> => {
  if (matches.length === MAX_MATCHES || index === records.length) return Effect.succeed(matches);
  const record = records[index];
  if (record === undefined || record === "") return collectRecords(records, parse, matches, index + 1);
  if (Buffer.byteLength(record) > jsonRecordMaxBytes) {
    return Effect.fail(toolError("exec-failed", "ripgrep output record exceeded the parsing limit"));
  }
  return parse(record).pipe(
    Effect.flatMap((match) =>
      collectRecords(records, parse, match === null ? matches : matches.concat(match), index + 1),
    ),
  );
};

const collectDelimitedOutput = <A>(
  chunks: AsyncIterator<string>,
  separator: string,
  parse: (record: string) => Effect.Effect<A | null, ToolError>,
  output: CollectedOutput<A> = { matches: [], buffered: "" },
): Effect.Effect<CollectedOutput<A>, ToolError> =>
  processCommand(() => chunks.next()).pipe(
    Effect.flatMap((next) => {
      const { buffered, records } = splitRecords(output.buffered, next, separator);
      if (Buffer.byteLength(buffered) > jsonRecordMaxBytes) {
        return Effect.fail(toolError("exec-failed", "ripgrep output record exceeded the parsing limit"));
      }
      return collectRecords(records, parse, output.matches).pipe(
        Effect.flatMap((matches) => {
          const collected = { buffered, matches };
          if (next.done || matches.length === MAX_MATCHES) return Effect.succeed(collected);
          return collectDelimitedOutput(chunks, separator, parse, collected);
        }),
      );
    }),
  );

const RipgrepEvent = Schema.Struct({ type: Schema.String });
const RipgrepString = Schema.Union([
  Schema.Struct({ text: Schema.String }),
  Schema.Struct({ bytes: Schema.String }),
]);
const RipgrepMatchEvent = Schema.Struct({
  type: Schema.Literal("match"),
  data: Schema.Struct({
    path: RipgrepString,
    lines: RipgrepString,
    line_number: Schema.Finite,
  }),
});
const decodeRipgrepEvent = Schema.decodeUnknownOption(RipgrepEvent);
const decodeRipgrepMatchEvent = Schema.decodeUnknownOption(RipgrepMatchEvent);
const decodeRipgrepJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const parseRipgrepJson = (line: string) =>
  decodeRipgrepJson(line).pipe(
    Effect.mapError((cause) => toolError("exec-failed", `invalid ripgrep output: ${String(cause)}`)),
  );

const parseGrepMatch = (base: string, include: RegExp | null, matcher: RegExp, line: string) =>
  Effect.gen(function* () {
    const json = yield* parseRipgrepJson(line);
    const event = decodeRipgrepEvent(json);
    if (Option.isNone(event)) {
      return yield* toolError("exec-failed", "invalid ripgrep event");
    }
    if (event.value.type !== "match") return null;
    const match = decodeRipgrepMatchEvent(json);
    if (Option.isNone(match)) {
      return yield* toolError("exec-failed", "invalid ripgrep match event");
    }
    if (!("text" in match.value.data.path) || !("text" in match.value.data.lines)) return null;
    const path = relativeSearchPath(match.value.data.path.text);
    const relative = pathWithinBase(base, path);
    if (relative === null || (include !== null && !include.test(relative))) return null;
    const text = match.value.data.lines.text;
    const normalizedText = text.endsWith("\n") ? text.slice(0, -1) : text;
    if (!matcher.test(normalizedText)) return null;
    return {
      path,
      line: match.value.data.line_number,
      text: normalizedText,
    } satisfies GrepMatch;
  });

const stopAtMatchLimit = <A>(process: SpawnHandle, matches: ReadonlyArray<A>) => {
  if (matches.length < MAX_MATCHES) return Effect.succeed(matches);
  return processCommand(() => process.kill("SIGTERM")).pipe(Effect.map(() => matches));
};

const collectGlobMatches = (process: SpawnHandle, base: string, matcher: RegExp) =>
  collectDelimitedOutput(process.stdout[Symbol.asyncIterator](), "\0", (record) => {
    const path = relativeSearchPath(record);
    const relative = pathWithinBase(base, path);
    if (relative === null || !matcher.test(relative)) return Effect.succeed(null);
    return Effect.succeed(path);
  }).pipe(Effect.flatMap((output) => stopAtMatchLimit(process, output.matches)));

const collectGrepOutput = (process: SpawnHandle, base: string, include: RegExp | null, matcher: RegExp) =>
  collectDelimitedOutput(process.stdout[Symbol.asyncIterator](), "\n", (record) =>
    parseGrepMatch(base, include, matcher, record),
  ).pipe(Effect.flatMap((output) => stopAtMatchLimit(process, output.matches)));

const runSearch = <A>(
  sandbox: WorktreeSandbox,
  command: string,
  base: string,
  collect: (process: SpawnHandle) => Effect.Effect<ReadonlyArray<A>, ToolError>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const running = yield* acquireSearchProcess(sandbox, command);
      const result = yield* Effect.all(
        {
          matches: collect(running.process),
          stderr: collectStderr(running.process.stderr),
          exitCode: processCommand(() => running.exit),
        },
        { concurrency: "unbounded" },
      );
      yield* Deferred.succeed(running.completed, undefined);
      return { ...result, limitReached: result.matches.length === MAX_MATCHES };
    }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: searchDeadline,
      orElse: () => Effect.fail(toolError("timeout", `search timed out after ${searchDeadline}`, base)),
    }),
  );

const failedSearch = (name: "glob" | "grep", base: string, stderr: string, exitCode: number) =>
  toolError("exec-failed", `${name} search exited ${exitCode}: ${stderr.trim()}`, base);

const searchSucceeded = (limitReached: boolean, exitCode: number) =>
  limitReached || exitCode === 0 || exitCode === 1;

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
    Effect.timeoutOrElse({
      duration: bashDeadline,
      orElse: () =>
        Effect.fail(toolError("timeout", `bash command timed out after ${bashDeadline}`, cwd ?? null)),
    }),
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
  if (yield* prepareSearchBase(sandbox, base)) return { matches: [] };
  const matcher = globToRegExp(args.pattern);
  const command = searchCommand([
    "--files",
    "--null",
    ...searchArgs,
    ...searchExclusions,
    "--",
    searchTarget(base),
  ]);
  const result = yield* runSearch(sandbox, command, base, (process) =>
    collectGlobMatches(process, base, matcher),
  );
  if (!searchSucceeded(result.limitReached, result.exitCode)) {
    return yield* failedSearch("glob", base, result.stderr, result.exitCode);
  }
  return { matches: result.matches };
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
  const compiled = yield* compileRegExp(args.pattern);
  const base = args.path === undefined ? "" : yield* confine(args.path);
  if (yield* prepareSearchBase(sandbox, base)) return { matches: [] };
  const include = args.include === undefined ? null : globToRegExp(args.include);
  const command = searchCommand([
    "--json",
    "--line-number",
    "--pcre2",
    ...searchArgs,
    ...searchExclusions,
    "--regexp",
    compiled.searchPattern,
    "--",
    searchTarget(base),
  ]);
  const result = yield* runSearch(sandbox, command, base, (process) =>
    collectGrepOutput(process, base, include, compiled.matcher),
  );
  if (searchSucceeded(result.limitReached, result.exitCode)) {
    return { matches: result.matches };
  }
  if (result.stderr.includes("regex parse error") || result.stderr.includes("PCRE2:")) {
    return yield* toolError("invalid-args", `invalid grep pattern: ${result.stderr.trim()}`, base);
  }
  return yield* failedSearch("grep", base, result.stderr, result.exitCode);
});

const javascriptEscapeLetters = "bBcdDfknrsStuvwWx";

const translateJavascriptPattern = (pattern: string) =>
  pattern.replace(/\\\\|\\([A-Za-z])/g, (sequence, escaped: string | undefined, offset: number) => {
    if (escaped === undefined) return sequence;
    if (escaped === "v") return "\\x0B";
    if (escaped === "u" && pattern[offset + 2] === "{") return "u";
    if (escaped === "k" && pattern[offset + 2] !== "<") return "k";
    if (!javascriptEscapeLetters.includes(escaped)) return escaped;
    return sequence;
  });

const requiresJavascriptFiltering = (pattern: string) =>
  /(?:^|[^\\])(?:\\\\)*(?:\.|\[|\\[1-9bBdDkKsSuWw])/.test(pattern);

const compileRegExp = (pattern: string) =>
  Effect.try({
    try: () => {
      const matcher = RegExp(pattern);
      const searchPattern = requiresJavascriptFiltering(pattern) ? ".*" : translateJavascriptPattern(pattern);
      return { matcher, searchPattern };
    },
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
  return yield* Effect.gen(function* () {
    const response = yield* client.get(args.url);
    const content = yield* response.text;
    return { url: args.url, status: response.status, content };
  }).pipe(
    Effect.mapError((cause) => toolError("fetch-failed", cause.message)),
    Effect.timeoutOrElse({
      duration: webFetchDeadline,
      orElse: () => Effect.fail(toolError("timeout", `webfetch timed out after ${webFetchDeadline}`)),
    }),
  );
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
