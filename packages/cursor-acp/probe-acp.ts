import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";

const MODEL = process.env.SPIKE_MODEL ?? "auto";
const AGENT_BIN = process.env.SPIKE_AGENT_BIN ?? "agent";
const MODE = process.env.SPIKE_MODE; // undefined (agent) | "plan" | "ask"
// How the client reacts to Cursor's blocking extension methods:
//   "refuse" (default) → reply -32601 method-not-found, like @tanstack/ai-acp does
//   "hang"             → never reply, to measure whether Cursor's turn stalls
const EXT_BEHAVIOR = process.env.SPIKE_EXT ?? "refuse";
const PROMPT =
  process.env.SPIKE_PROMPT ??
  "Before doing anything else, use your ask-question capability to ask me one clarifying question about what to name a new file, and wait for my answer.";

const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "spike-acp-probe-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "spike@example.com");
  git("config", "user.name", "spike");
  writeFileSync(join(dir, "NOTES.md"), "# scratch\n\nseed line\n");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  return dir;
};

const incomingExtMethods: string[] = [];

const main = async () => {
  const dir = scratch();
  console.log(`scratch: ${dir}`);
  console.log(`model=${MODEL} agent=${AGENT_BIN} extBehavior=${EXT_BEHAVIOR}\n`);

  const args = ["--model", MODEL, ...(MODE ? ["--mode", MODE] : []), "acp"];
  console.log(`spawn: ${AGENT_BIN} ${args.join(" ")}\n`);
  const proc = spawn(AGENT_BIN, args, {
    cwd: dir,
    stdio: ["pipe", "pipe", "inherit"],
    env: process.env,
  });

  const stream = ndJsonStream(Writable.toWeb(proc.stdin), Readable.toWeb(proc.stdout));

  const client = {
    requestPermission: async (params: { options: Array<{ optionId: string; kind: string }> }) => {
      const allow =
        params.options.find((o) => o.kind === "allow_always") ??
        params.options.find((o) => o.kind === "allow_once") ??
        params.options[0];
      console.log(`  [permission] auto-allow ${allow?.optionId}`);
      return { outcome: { outcome: "selected" as const, optionId: allow.optionId } };
    },
    sessionUpdate: async (params: { update: { sessionUpdate: string } }) => {
      const u = params.update;
      if (u.sessionUpdate === "agent_message_chunk" || u.sessionUpdate === "agent_thought_chunk") {
        const text = (u as { content?: { text?: string } }).content?.text;
        if (text)
          process.stdout.write(u.sessionUpdate === "agent_thought_chunk" ? `\x1b[2m${text}\x1b[0m` : text);
      } else {
        console.log(`  [update:${u.sessionUpdate}] ${JSON.stringify(u)?.slice(0, 600)}`);
      }
    },
    extMethod: async (method: string, params: unknown) => {
      incomingExtMethods.push(method);
      console.log(`\n  >>> INCOMING EXT REQUEST: ${method} ${JSON.stringify(params)?.slice(0, 300)}`);
      if (EXT_BEHAVIOR === "hang") {
        console.log(`  (hang mode: never responding to ${method})`);
        return new Promise(() => {});
      }
      throw RequestError.methodNotFound(method);
    },
    extNotification: async (method: string, params: unknown) => {
      incomingExtMethods.push(`(notif)${method}`);
      console.log(`  [ext-notification] ${method} ${JSON.stringify(params)?.slice(0, 200)}`);
    },
  };

  const connection = new ClientSideConnection(() => client, stream);

  const init = await connection.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  });
  console.log(`initialize: protocol=${init.protocolVersion}`);
  console.log(`  agentCapabilities=${JSON.stringify(init.agentCapabilities)}`);
  console.log(`  authMethods=${JSON.stringify(init.authMethods)}`);

  const session = await connection.newSession({ cwd: dir, mcpServers: [] });
  console.log(`session/new: ${session.sessionId}`);

  console.log(`\n--- session/prompt (${EXT_BEHAVIOR}) ---`);
  const promptStart = Date.now();
  const promptResult = await connection.prompt({
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: PROMPT }],
  });
  const promptMs = Date.now() - promptStart;
  console.log(`\nprompt stopReason=${promptResult.stopReason} elapsedMs=${promptMs}`);
  console.log(`prompt FULL response=${JSON.stringify(promptResult)}`);

  console.log(`\n--- session/load (resume in same process) ---`);
  const loadResult = await connection
    .loadSession({ sessionId: session.sessionId, cwd: dir, mcpServers: [] })
    .then(() => ({ ok: true as const }))
    .catch((e: unknown) => ({ ok: false as const, error: e }));
  if (loadResult.ok) {
    console.log(`session/load OK — resume works`);
  } else {
    const err = loadResult.error;
    const code = err instanceof RequestError ? err.code : undefined;
    console.log(
      `session/load FAILED code=${code} message=${err instanceof Error ? err.message : String(err)}`,
    );
  }

  console.log(`\nincoming ext methods seen: ${JSON.stringify([...new Set(incomingExtMethods)])}`);

  writeFileSync(
    join(import.meta.dirname, "probe-summary.json"),
    `${JSON.stringify(
      {
        model: MODEL,
        extBehavior: EXT_BEHAVIOR,
        agentCapabilities: init.agentCapabilities,
        authMethods: init.authMethods,
        sessionId: session.sessionId,
        prompt: {
          stopReason: promptResult.stopReason,
          elapsedMs: promptMs,
          usage: (promptResult as { usage?: unknown }).usage,
        },
        sessionLoad: loadResult.ok
          ? { ok: true }
          : { ok: false, code: loadResult.error instanceof RequestError ? loadResult.error.code : undefined },
        incomingExtMethods: [...new Set(incomingExtMethods)],
        scratchDir: dir,
      },
      null,
      2,
    )}\n`,
  );

  proc.kill();
  process.exit(0);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
