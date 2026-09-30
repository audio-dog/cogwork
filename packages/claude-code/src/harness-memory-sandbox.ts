import { fileURLToPath } from "node:url";
import type {
  ProcessOptions,
  SandboxCapabilities,
  SandboxFsStat,
  SandboxHandle,
  SandboxProvider,
  SpawnHandle,
} from "@tanstack/ai-sandbox";
import * as Schema from "effect/Schema";
import { networkEnvironmentProbe, windowsEnvironmentProbe } from "./harness-test-data";

interface MemoryWorkspace {
  readonly files: Map<string, Uint8Array>;
  readonly directories: Set<string>;
  readonly environment: Map<string, string>;
  readonly process: { stopped: boolean };
}

interface LocalProcessSandboxConfig {
  readonly dir?: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const workspaces = new Map<string, MemoryWorkspace>();
const capabilities = {
  fs: true,
  exec: true,
  env: true,
  ports: true,
  backgroundProcesses: true,
  writableStdin: true,
  killableProcesses: true,
  snapshots: false,
  networkPolicy: false,
  durableFilesystem: false,
  fork: false,
} satisfies SandboxCapabilities;

const normalizePath = (path: string) => {
  const normalized = path
    .replaceAll("\\", "/")
    .replace(`${repositoryRoot}/`, "")
    .replace(/^\/workspace\/?/, "")
    .replace(/^\.\//, "")
    .replace(/\/$/, "");
  return normalized === "." ? "" : normalized;
};

const parentPaths = (path: string) => {
  const parts = normalizePath(path).split("/").filter(Boolean);
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
};

const makeWorkspace = () => ({
  files: new Map<string, Uint8Array>(),
  directories: new Set([""]),
  environment: new Map<string, string>(),
  process: { stopped: true },
});

const writeFile = (workspace: MemoryWorkspace, path: string, data: string | Uint8Array) => {
  parentPaths(path).forEach((parent) => {
    workspace.directories.add(parent);
  });
  workspace.files.set(normalizePath(path), typeof data === "string" ? encoder.encode(data) : data.slice());
};

const readFile = (workspace: MemoryWorkspace, path: string) => {
  const value = workspace.files.get(normalizePath(path));
  if (!value) throw new Error(`missing memory Sandbox file: ${path}`);
  return decoder.decode(value);
};

const valueAfter = (args: ReadonlyArray<string>, flag: string) => {
  const index = args.indexOf(flag);
  return index < 0 ? null : (args.at(index + 1) ?? null);
};

const environmentValue = (environment: ReadonlyMap<string, string>, name: string | null) =>
  name === null ? null : (environment.get(name) ?? null);

const environmentValues = (environment: ReadonlyMap<string, string>, names: ReadonlyArray<string>) =>
  Object.fromEntries(names.map((name) => [name, environmentValue(environment, name)]));

const windowsEnvironmentNames = Object.keys(windowsEnvironmentProbe);
const networkEnvironmentNames = Object.keys(networkEnvironmentProbe);

const runErrorEntries = [
  ["--run-error", "Claude turn failed"],
  ["--authentication-run-error", "MCP server authentication failed"],
  ["--mcp-api-key-run-error", "MCP server invalid API key"],
  ["--unqualified-api-key-run-error", "authentication_error: invalid x-api-key"],
] satisfies ReadonlyArray<readonly [string, string]>;

const readMcpConfig = (workspace: MemoryWorkspace, argument: string | null) => {
  const configArgument = argument || null;
  return configArgument?.startsWith("{") === false ? readFile(workspace, configArgument) : configArgument;
};

const makeCapture = (
  workspace: MemoryWorkspace,
  args: ReadonlyArray<string>,
  prompt: string,
  options: ProcessOptions | undefined,
) => {
  const environment = new Map([...workspace.environment, ...Object.entries(options?.env ?? {})]);
  const mcpConfigArgument = valueAfter(args, "--mcp-config");
  const mcpConfig = readMcpConfig(workspace, mcpConfigArgument);
  const mcpEnvironmentName = mcpConfig?.match(/\$\{([^}]+)\}/)?.[1] ?? null;
  const mcpBearer = environmentValue(environment, mcpEnvironmentName);
  const apiKey = environmentValue(environment, "ANTHROPIC_API_KEY");
  return {
    args: args.slice(2),
    prompt,
    agents: readFile(workspace, "AGENTS.md"),
    cwd: options?.cwd ?? ".",
    files: [...workspace.files.keys()].toSorted(),
    settingSources: valueAfter(args, "--setting-sources"),
    settings: valueAfter(args, "--settings"),
    resume: valueAfter(args, "--resume"),
    forkSession: args.includes("--fork-session"),
    authMode: args.includes("--bare") ? "bare" : "host",
    permissionMode: valueAfter(args, "--permission-mode"),
    systemPrompt: valueAfter(args, "--append-system-prompt") ?? valueAfter(args, "--system-prompt"),
    mcpConfigArgument,
    mcpConfig,
    mcpBearer,
    mcpBearerPresent: mcpBearer !== null,
    apiKey,
    apiKeyPresent: apiKey !== null,
    apiKeyVersion: apiKey?.match(/-(one|two)$/)?.[1] ?? null,
    authToken: environmentValue(environment, "ANTHROPIC_AUTH_TOKEN"),
    githubToken: environmentValue(environment, "GITHUB_TOKEN"),
    ghToken: environmentValue(environment, "GH_TOKEN"),
    claudeConfigDir: environmentValue(environment, "CLAUDE_CONFIG_DIR"),
    windowsEnvironment: environmentValues(environment, windowsEnvironmentNames),
    networkEnvironment: environmentValues(environment, networkEnvironmentNames),
  };
};

const listEntries = (paths: Iterable<string>, directory: string, type: "file" | "dir") => {
  const prefix = directory ? `${directory}/` : "";
  const isDirectChild = (path: string) => {
    const relative = path.slice(prefix.length);
    return path.startsWith(prefix) && path !== directory && relative !== "" && !relative.includes("/");
  };
  return [...paths].filter(isDirectChild).map((path) => ({
    name: path.slice(prefix.length),
    path,
    type,
  }));
};

const makeSpawn = (
  workspace: MemoryWorkspace,
  command: string,
  options: ProcessOptions | undefined,
): SpawnHandle => {
  const argvPath = command.match(/tanstack-claude-argv-[^']+\.json/)?.[0];
  if (!argvPath) throw new Error(`memory Sandbox received unsupported spawn command: ${command}`);
  const parsed: unknown = JSON.parse(readFile(workspace, argvPath));
  const args = Schema.decodeUnknownSync(Schema.Array(Schema.String))(parsed);
  const input: Array<string> = [];
  const started = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  const stop = () => {
    workspace.process.stopped = true;
    stopped.resolve();
  };
  workspace.process.stopped = false;
  options?.signal?.addEventListener("abort", stop, { once: true });
  if (options?.signal?.aborted) stop();

  const outputState: { chunks?: Array<string> } = {};
  const outputChunks = () => {
    const capture = makeCapture(workspace, args, input.join(""), options);
    const sessionId = capture.resume ?? "fake-claude-session-1";
    const init = {
      type: "system",
      subtype: "init",
      session_id: sessionId,
      model: valueAfter(args, "--model") ?? "sonnet",
      tools: ["Read", "Edit", "Bash"],
      skills: ["ambient-skill"],
      instructions: ["ambient-instruction"],
      plugins: ["ambient-plugin"],
      hooks: ["ambient-hook"],
      settings: { sources: ["user", "project"] },
    };
    const apiKeyError = args.includes("--api-key-run-error")
      ? `Claude API key rejected: ${capture.apiKey}`
      : null;
    const runError = runErrorEntries.find(([flag]) => args.includes(flag))?.[1] ?? apiKeyError;
    const events = [
      {
        type: "assistant",
        message: {
          id: "assistant-1",
          content: [
            { type: "thinking", thinking: "checking the workspace" },
            { type: "text", text: "completed" },
            { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "tracked.txt" } },
          ],
        },
        parent_tool_use_id: null,
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool-1", content: "initial" }],
        },
        parent_tool_use_id: null,
      },
      {
        type: "result",
        subtype: "success",
        result: JSON.stringify(capture),
        structured_output: capture,
        usage: { input_tokens: 13, output_tokens: 8, cache_read_input_tokens: 3 },
        total_cost_usd: 0.01,
      },
    ];
    const tails = [
      {
        when: () => args.includes("--hang"),
        chunks: () => [],
      },
      {
        when: () => runError !== null,
        chunks: () => [
          `${JSON.stringify({ type: "result", subtype: "error_during_execution", errors: [runError] })}\n`,
        ],
      },
    ];
    const tail = tails.find(({ when }) => when())?.chunks() ?? [
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    ];
    return [`${JSON.stringify(init)}\n`, ...tail];
  };
  const done = { value: undefined, done: true } satisfies IteratorReturnResult<undefined>;
  const nextOutput = () => {
    outputState.chunks ??= outputChunks();
    const chunk = outputState.chunks.shift();
    const outputs = [
      {
        when: () => chunk !== undefined,
        value: () =>
          Promise.resolve({ value: chunk ?? "", done: false } satisfies IteratorYieldResult<string>),
      },
      {
        when: () => !args.includes("--hang"),
        value: () => Promise.resolve(done),
      },
      {
        when: () => true,
        value: () => stopped.promise.then(() => done),
      },
    ];
    return outputs.find(({ when }) => when())?.value() ?? Promise.resolve(done);
  };
  const stdout = {
    [Symbol.asyncIterator]: () => ({
      next: () => started.promise.then<IteratorResult<string>>(nextOutput),
    }),
  } satisfies AsyncIterable<string>;
  const waitForExit = () =>
    started.promise.then(() => (args.includes("--hang") ? stopped.promise.then(() => 0) : 0));

  return {
    pid: 1,
    stdout,
    stderr: {
      [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve(done) }),
    },
    stdin: {
      write: (data) => {
        input.push(data);
        return Promise.resolve();
      },
      end: () => {
        if (args.includes("--hang")) writeFile(workspace, ".claude-pid", "1");
        started.resolve();
        return Promise.resolve();
      },
    },
    wait: waitForExit,
    kill: () => {
      stop();
      return Promise.resolve();
    },
  };
};

const makeExec = (workspace: MemoryWorkspace) => (command: string) => {
  const handlers = [
    {
      when: () => command.includes("ps -o stat="),
      run: () => ({ stdout: "", stderr: "", exitCode: workspace.process.stopped ? 0 : 1 }),
    },
    {
      when: () => command.includes("missing-claude-code"),
      run: () => ({ stdout: "", stderr: "command not found", exitCode: 127 }),
    },
    {
      when: () => command.endsWith(" --version"),
      run: () => ({ stdout: "2.1.238 (Claude Code)\n", stderr: "", exitCode: 0 }),
    },
    {
      when: () => command.endsWith(" auth status --json"),
      run: () => ({ stdout: '{"loggedIn":true}\n', stderr: "", exitCode: 0 }),
    },
  ];
  const result = handlers.find(({ when }) => when())?.run() ?? { stdout: "", stderr: "", exitCode: 0 };
  return Promise.resolve(result);
};

const makeHandle = (workspace: MemoryWorkspace): SandboxHandle => ({
  id: repositoryRoot,
  provider: "local-process",
  workspaceRoot: repositoryRoot,
  capabilities,
  fs: {
    read: (path) => Promise.resolve(readFile(workspace, path)),
    readBytes: (path) => {
      const value = workspace.files.get(normalizePath(path));
      if (!value) return Promise.reject(new Error(`missing memory Sandbox file: ${path}`));
      return Promise.resolve(value.slice());
    },
    write: (path, data) => {
      writeFile(workspace, path, data);
      return Promise.resolve();
    },
    list: (path) => {
      const directory = normalizePath(path);
      return Promise.resolve([
        ...listEntries(workspace.directories, directory, "dir"),
        ...listEntries(workspace.files.keys(), directory, "file"),
      ]);
    },
    mkdir: (path) => {
      workspace.directories.add(normalizePath(path));
      parentPaths(path).forEach((parent) => {
        workspace.directories.add(parent);
      });
      return Promise.resolve();
    },
    remove: (path) => {
      const target = normalizePath(path);
      workspace.files.delete(target);
      [...workspace.files.keys()]
        .filter((entry) => entry.startsWith(`${target}/`))
        .forEach((entry) => {
          workspace.files.delete(entry);
        });
      workspace.directories.delete(target);
      return Promise.resolve();
    },
    rename: (from, to) => {
      const value = workspace.files.get(normalizePath(from));
      if (!value) return Promise.reject(new Error(`missing memory Sandbox file: ${from}`));
      writeFile(workspace, to, value);
      workspace.files.delete(normalizePath(from));
      return Promise.resolve();
    },
    exists: (path) => {
      const normalized = normalizePath(path);
      const pathExists = workspace.files.has(normalized) || workspace.directories.has(normalized);
      return Promise.resolve(pathExists);
    },
    lstat: (path) => {
      const normalized = normalizePath(path);
      const file = workspace.files.get(normalized);
      const entries = [
        {
          when: () => file !== undefined,
          stat: () => ({ type: "file", mode: 0o100644, size: file?.byteLength ?? 0 }) satisfies SandboxFsStat,
        },
        {
          when: () => workspace.directories.has(normalized),
          stat: () => ({ type: "dir", mode: 0o040755 }) satisfies SandboxFsStat,
        },
      ];
      return Promise.resolve(entries.find(({ when }) => when())?.stat());
    },
  },
  git: {
    clone: () => Promise.resolve(),
    status: () => Promise.resolve(""),
    add: () => Promise.resolve(),
    commit: () => Promise.resolve(),
    push: () => Promise.resolve(),
    pull: () => Promise.resolve(),
    branch: () => Promise.resolve("main"),
  },
  process: {
    exec: makeExec(workspace),
    spawn: (command, options) => Promise.resolve(makeSpawn(workspace, command, options)),
  },
  ports: {
    connect: (port) => Promise.resolve({ url: `http://127.0.0.1:${port}` }),
  },
  env: {
    set: (values) => {
      Object.entries(values).forEach(([name, value]) => {
        workspace.environment.set(name, value);
      });
      return Promise.resolve();
    },
  },
  destroy: () => Promise.resolve(),
});

export const localProcessSandbox = (config: LocalProcessSandboxConfig = {}): SandboxProvider => ({
  name: "local-process",
  capabilities: () => capabilities,
  create: () => {
    const workspace = config.dir ? (workspaces.get(repositoryRoot) ?? makeWorkspace()) : makeWorkspace();
    workspaces.set(repositoryRoot, workspace);
    return Promise.resolve(makeHandle(workspace));
  },
  resume: () => Promise.resolve(null),
  destroy: () => Promise.resolve(),
});
