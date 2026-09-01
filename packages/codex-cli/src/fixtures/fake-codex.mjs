import { once } from "node:events";
import { access, readFile, writeFile } from "node:fs/promises";

const probeDelayArgument = process.argv.find((argument) => argument.startsWith("--fake-probe-delay="));
const probeDelay = Number(probeDelayArgument?.slice("--fake-probe-delay=".length) ?? 0);
if (probeDelay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, probeDelay);
const ignoresSigterm = process.argv.includes("--ignore-sigterm");
if (ignoresSigterm) {
  const block = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  process.on("SIGHUP", block);
  process.on("SIGTERM", block);
}

if (process.argv.includes("--version")) {
  if (process.argv.includes("--fake-version-failure")) {
    process.stderr.write("unexpected version failure\n");
    process.exit(2);
  }
  const override = process.argv.find((argument) => argument.startsWith("--fake-version="));
  process.stdout.write(
    `${override?.slice("--fake-version=".length).replaceAll("_", " ") ?? "codex-cli 1.0.0"}\n`,
  );
  process.exit(0);
}

if (process.argv.includes("login") && process.argv.includes("status")) {
  if (process.argv.includes("--fake-login-failure")) {
    process.stderr.write("You are not logged in\n");
    process.exit(1);
  }
  process.stdout.write("Logged in\n");
  process.exit(0);
}

const prompt = Buffer.concat(await Array.fromAsync(process.stdin)).toString("utf8");
const mcpEnvIndex = process.argv.indexOf("--capture-mcp-env");
const mcpEnvName = mcpEnvIndex === -1 ? undefined : process.argv.at(mcpEnvIndex + 1);
const mcpBearer = mcpEnvName ? process.env[mcpEnvName] : undefined;
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
