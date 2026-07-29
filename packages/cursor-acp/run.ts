import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chat, EventType } from "@tanstack/ai";
import { acpCompatible } from "@tanstack/ai-acp";
import { defineSandbox, defineWorkspace, withSandbox } from "@tanstack/ai-sandbox";
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process";

const MODEL = process.env.SPIKE_MODEL ?? "auto";
const AGENT_BIN = process.env.SPIKE_AGENT_BIN ?? "agent";

const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "spike-cursor-acp-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "spike@example.com");
  git("config", "user.name", "spike");
  writeFileSync(join(dir, "NOTES.md"), "# scratch\n\nseed line\n");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  return dir;
};

const cursor = acpCompatible({
  name: "cursor",
  models: [MODEL],
  command: ({ model }) => `${AGENT_BIN} --model ${model} acp`,
  planEventName: "cursor.plan",
  onExtNotification: (method, params) => {
    console.log(`  [ext-notification] ${method} ${JSON.stringify(params)?.slice(0, 200)}`);
  },
});

type TurnOutcome = {
  emittedSessionId: string | undefined;
  finalText: string;
  usage: unknown;
  finishReason: string | undefined;
  runError: string | undefined;
  customEvents: string[];
};

const drive = async (
  dir: string,
  prompt: string,
  resumeSessionId: string | undefined,
): Promise<TurnOutcome> => {
  const sandbox = defineSandbox({
    id: "cursor-spike",
    provider: localProcessSandbox({ dir }),
    workspace: defineWorkspace({ source: { type: "none" } }),
  });

  const stream = chat({
    adapter: cursor(MODEL),
    messages: [{ role: "user", content: prompt }],
    middleware: [withSandbox(sandbox)],
    ...(resumeSessionId ? { modelOptions: { sessionId: resumeSessionId } } : {}),
  });

  const outcome: TurnOutcome = {
    emittedSessionId: undefined,
    finalText: "",
    usage: undefined,
    finishReason: undefined,
    runError: undefined,
    customEvents: [],
  };

  for await (const chunk of stream) {
    if (chunk.type === EventType.CUSTOM) {
      outcome.customEvents.push(chunk.name);
      if (chunk.name === "cursor.session-id") {
        outcome.emittedSessionId = (chunk.value as { sessionId?: string })?.sessionId;
        console.log(`  [session-id] ${outcome.emittedSessionId}`);
      } else {
        console.log(`  [custom:${chunk.name}] ${JSON.stringify(chunk.value)?.slice(0, 200)}`);
      }
    } else if (chunk.type === EventType.TEXT_MESSAGE_CONTENT) {
      outcome.finalText += chunk.delta ?? "";
    } else if (chunk.type === EventType.TOOL_CALL_START) {
      console.log(`  [tool] ${chunk.toolCallName}`);
    } else if (chunk.type === EventType.RUN_FINISHED) {
      outcome.usage = chunk.usage;
      outcome.finishReason = chunk.finishReason;
    } else if (chunk.type === EventType.RUN_ERROR) {
      outcome.runError = chunk.message;
      console.log(`  [run-error] ${chunk.message}`);
    }
  }

  console.log(`  [assistant] ${outcome.finalText.trim().slice(0, 300)}`);
  return outcome;
};

const main = async () => {
  const dir = scratch();
  console.log(`scratch checkout: ${dir}`);
  console.log(`model: ${MODEL}  agent: ${AGENT_BIN}\n`);

  console.log("=== RUN 1 (fresh session) ===");
  const run1 = await drive(
    dir,
    "In one short sentence, state the single word on the seed line of NOTES.md. Then remember the secret codeword 'peridot' for later.",
    undefined,
  );

  console.log("\n=== RUN 2 (resume via modelOptions.sessionId) ===");
  const run2 = await drive(
    dir,
    "What was the secret codeword I told you earlier? Answer with just the word.",
    run1.emittedSessionId,
  );

  const resumeIdMatches =
    run1.emittedSessionId !== undefined && run1.emittedSessionId === run2.emittedSessionId;
  const remembered = /peridot/i.test(run2.finalText);

  const summary = {
    model: MODEL,
    run1: {
      sessionId: run1.emittedSessionId,
      usage: run1.usage,
      finishReason: run1.finishReason,
      customEvents: [...new Set(run1.customEvents)],
      runError: run1.runError,
    },
    run2: {
      requestedResumeId: run1.emittedSessionId,
      emittedSessionId: run2.emittedSessionId,
      usage: run2.usage,
      finishReason: run2.finishReason,
      customEvents: [...new Set(run2.customEvents)],
      runError: run2.runError,
    },
    findings: {
      q1_resume_session_id_preserved: resumeIdMatches,
      q1_context_remembered_across_runs: remembered,
      q2_usage_reported_run1: run1.usage !== undefined,
      q2_usage_reported_run2: run2.usage !== undefined,
    },
  };

  console.log(`\n=== SUMMARY ===\n${JSON.stringify(summary, null, 2)}`);
  writeFileSync(join(import.meta.dirname, "run-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
