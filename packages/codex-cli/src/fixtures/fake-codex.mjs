import { once } from "node:events";
import { access, readFile, writeFile } from "node:fs/promises";

const prompt = Buffer.concat(await Array.fromAsync(process.stdin)).toString("utf8");
const mcpBearer = Object.entries(process.env).findLast(([name]) => /^COGWORK_MCP_.*_BEARER$/.test(name))?.[1];
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
const outputSchemaPath = () => {
  const index = process.argv.indexOf("--output-schema");
  if (index === -1) return null;
  return process.argv.at(index + 1) ?? null;
};

const schemaPath = outputSchemaPath();
const schema = schemaPath ? JSON.parse(await readFile(schemaPath, "utf8")) : null;
const stage = schema?.properties?._tag?.enum?.[0];
const stageResponse = () => {
  if (stage === "implement")
    return JSON.stringify({ _tag: "implement", outcome: "opened-pr", summary: capture });
  if (stage === "follow-up") return JSON.stringify({ _tag: "follow-up", outcome: "noop", summary: capture });
  if (schema) return JSON.stringify({ _tag: "triage", role: "ready-for-agent", proposal: capture });
  return capture;
};
const response = stageResponse();
const events = [
  { type: "thread.started", thread_id: "fake-thread-1" },
  {
    type: "item.completed",
    item: { id: "message-1", type: "agent_message", text: response },
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
