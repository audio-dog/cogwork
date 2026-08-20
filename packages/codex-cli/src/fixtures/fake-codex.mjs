import { once } from "node:events";
import { access, writeFile } from "node:fs/promises";

const prompt = Buffer.concat(await Array.fromAsync(process.stdin)).toString("utf8");
const mcpBearer = Object.entries(process.env).find(([name]) => /^COGWORK_MCP_.*_BEARER$/.test(name))?.[1];
const hasCodexConfig = await access(`${process.cwd()}/.codex/config.toml`).then(
  () => true,
  () => false,
);
if (mcpBearer) await writeFile(`${process.cwd()}/.mcp-bearer`, mcpBearer);
const capture = JSON.stringify({
  args: process.argv.slice(2),
  prompt,
  cwd: process.cwd(),
  hasCodexConfig,
});
const events = [
  { type: "thread.started", thread_id: "fake-thread-1" },
  {
    type: "item.completed",
    item: { id: "message-1", type: "agent_message", text: capture },
  },
  {
    type: "turn.completed",
    usage: { input_tokens: 10, output_tokens: 5 },
  },
];

const run = async () => {
  if (!process.argv.includes("--hang")) {
    return process.stdout.write(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  }
  await writeFile(`${process.cwd()}/.pid`, String(process.pid));
  process.stdout.write(`${JSON.stringify(events[0])}\n`);
  await once(process, "SIGTERM");
  await writeFile(`${process.cwd()}/.terminated`, "terminated");
};

await run();
