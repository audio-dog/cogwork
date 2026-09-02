import { once } from "node:events";
import { readdir, readFile, writeFile } from "node:fs/promises";

const argument = (prefix) => process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);

if (process.argv.includes("--version")) {
  process.stdout.write(`${argument("--fake-version=")?.replaceAll("_", " ") ?? "2.1.238 (Claude Code)"}\n`);
  process.exit(0);
}

if (process.argv.includes("--help")) {
  const models = process.argv.includes("--empty-models")
    ? "Claude Code help"
    : "--model <model> Use 'fable', 'opus', or 'sonnet', or 'claude-fable-5'.";
  process.stdout.write(`${models}\n`);
  process.exit(0);
}

if (process.argv.includes("auth") && process.argv.includes("status")) {
  if (
    process.argv.includes("--require-clean-environment") &&
    (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)
  ) {
    process.stderr.write("Inherited Anthropic credentials detected\n");
    process.exit(1);
  }
  if (process.argv.includes("--not-authenticated")) {
    process.stderr.write("Not logged in\n");
    process.exit(1);
  }
  process.stdout.write('{"loggedIn":true}\n');
  process.exit(0);
}

const prompt = Buffer.concat(await Array.fromAsync(process.stdin)).toString("utf8");
const valueAfter = (flag) => {
  const index = process.argv.indexOf(flag);
  return index === -1 ? null : (process.argv.at(index + 1) ?? null);
};
const firstValueAfter = (...flags) => flags.map(valueAfter).find((value) => value !== null) ?? null;
const environmentValue = (name) => (name ? (process.env[name] ?? null) : null);
const agents = await readFile(`${process.cwd()}/AGENTS.md`, "utf8").catch(() => "");
const mcpConfig = valueAfter("--mcp-config");
const mcpEnvironmentName = mcpConfig?.match(/\$\{([^}]+)\}/)?.[1] ?? null;
if (process.argv.includes("--emit-change")) {
  await writeFile(`${process.cwd()}/tracked.txt`, "changed by Claude\n");
}
const capture = {
  args: process.argv.slice(2),
  prompt,
  agents,
  cwd: process.cwd(),
  files: await readdir(process.cwd(), { recursive: true }),
  settingSources: valueAfter("--setting-sources"),
  resume: valueAfter("--resume"),
  forkSession: process.argv.includes("--fork-session"),
  authMode: process.argv.includes("--bare") ? "bare" : "host",
  permissionMode: valueAfter("--permission-mode"),
  systemPrompt: firstValueAfter("--append-system-prompt", "--system-prompt"),
  mcpConfig,
  mcpBearer: environmentValue(mcpEnvironmentName),
  apiKey: process.env.ANTHROPIC_API_KEY ?? null,
  authToken: process.env.ANTHROPIC_AUTH_TOKEN ?? null,
};
const sessionId = capture.resume ?? "fake-claude-session-1";
const init = {
  type: "system",
  subtype: "init",
  session_id: sessionId,
  model: valueAfter("--model") ?? "sonnet",
  tools: ["Read", "Edit", "Bash"],
  skills: ["ambient-skill"],
  instructions: ["ambient-instruction"],
  plugins: ["ambient-plugin"],
  hooks: ["ambient-hook"],
  settings: { sources: ["user", "project"] },
};

if (process.argv.includes("--hang")) {
  await writeFile(`${process.cwd()}/.claude-pid`, String(process.pid));
  process.stdout.write(`${JSON.stringify(init)}\n`);
  await once(process, "SIGTERM");
  process.exit(0);
}

if (process.argv.includes("--run-error")) {
  process.stdout.write(
    `${[init, { type: "result", subtype: "error_during_execution", errors: ["Claude turn failed"] }]
      .map((event) => JSON.stringify(event))
      .join("\n")}\n`,
  );
  process.exit(0);
}

const events = [
  init,
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

process.stdout.write(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
