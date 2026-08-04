import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Readable, Writable } from "node:stream";
import { scheduler } from "node:timers/promises";
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";

const MODEL = process.env.SPIKE_MODEL ?? "auto";
const AGENT_BIN = process.env.SPIKE_AGENT_BIN ?? "agent";
const TURN_CAP_MS = Number(process.env.SPIKE_TURN_CAP_MS ?? 240_000);
const STOP_AFTER_TOOLS = Number(process.env.SPIKE_STOP_AFTER_TOOLS ?? 2);
const SETTLE_MS = 1_000;
const REPLAY_DRAIN_MS = 1_500;

const ARMS = ["completed", "cancelled", "killed"] as const;
type Arm = (typeof ARMS)[number];

const selectedArms = (process.env.SPIKE_ARMS?.split(",").map((a) => a.trim()) ?? [...ARMS]).filter(
  (a): a is Arm => (ARMS as ReadonlyArray<string>).includes(a),
);

const PLANT_PROMPT =
  "Remember the codeword 'peridot' for the rest of this conversation. Reply with exactly: READY";

const STEP_PROMPT =
  "Work through five steps strictly one at a time, in order. For each step N from 1 to 5: " +
  "create a file named step-N.md whose only line is 'step N complete', then write a line saying STEP N DONE. " +
  "Do not batch the steps, do not skip ahead, and do not create later files early.";

const RECALL_PROMPT =
  "Do no work and change no files. Answer in exactly two short lines. " +
  "Line 1: the codeword I gave you earlier, or UNKNOWN. " +
  "Line 2: the last task I asked you to do and how far you got, or UNKNOWN.";

const NUDGE_PROMPT =
  "You were interrupted part-way through the task above and this session has just been resumed. " +
  "Nothing has changed except that time passed. Inspect the working directory to see how far you got, " +
  "then continue from exactly where you stopped. Do not start over and do not redo completed work. " +
  "If the task is already complete, say COMPLETE and stop.";

type Update = { readonly sessionUpdate: string } & Record<string, unknown>;

const textOf = (update: Update) => (update as { content?: { text?: string } }).content?.text ?? "";

const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "spike-resume-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "spike@example.com");
  git("config", "user.name", "spike");
  writeFileSync(join(dir, "NOTES.md"), "# scratch\n\nseed line\n");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  return dir;
};

const stepFiles = (dir: string) =>
  readdirSync(dir)
    .filter((name) => /^step-\d+\.md$/.test(name))
    .sort()
    .map((name) => ({ name, mtimeMs: statSync(join(dir, name)).mtimeMs }));

// Cursor's store keeps its root pointer as hex-encoded JSON under `meta` key "0".
const storeSnapshot = (sessionId: string) => {
  try {
    using db = new DatabaseSync(join(homedir(), ".cursor", "acp-sessions", sessionId, "store.db"), {
      readOnly: true,
    });
    const blobs = db.prepare("select count(*) as n from blobs").get() as { n: number };
    const meta = db.prepare("select value from meta where key = '0'").get() as { value?: string } | undefined;
    const root = meta?.value
      ? (JSON.parse(Buffer.from(meta.value, "hex").toString("utf8")) as { latestRootBlobId?: string })
      : undefined;
    return { ok: true as const, blobCount: blobs.n, rootBlobId: root?.latestRootBlobId };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
  }
};

// Cursor blocks its turn on these vendor requests, then discards the reply.
const cursorMethodsThatBlockTheTurn = new Set(["cursor/task", "cursor/update_todos"]);

const openAgent = async (dir: string) => {
  const proc = spawn(AGENT_BIN, ["--model", MODEL, "acp"], {
    cwd: dir,
    stdio: ["pipe", "pipe", "ignore"],
    env: process.env,
  });
  const stream = ndJsonStream(Writable.toWeb(proc.stdin), Readable.toWeb(proc.stdout));
  const sink: { onUpdate: (update: Update) => void } = { onUpdate: () => {} };

  const client = {
    requestPermission: async (params: { options: Array<{ optionId: string; kind: string }> }) => {
      const allow =
        params.options.find((o) => o.kind === "allow_always") ??
        params.options.find((o) => o.kind === "allow_once") ??
        params.options[0];
      return { outcome: { outcome: "selected" as const, optionId: allow.optionId } };
    },
    sessionUpdate: async (params: { update: Update }) => {
      sink.onUpdate(params.update);
    },
    extMethod: async (method: string) => {
      if (cursorMethodsThatBlockTheTurn.has(method)) return {};
      throw RequestError.methodNotFound(method);
    },
    extNotification: async () => {},
  };

  const connection = new ClientSideConnection(() => client, stream);
  const init = await connection.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  });
  return { proc, connection, init, sink };
};

type Agent = Awaited<ReturnType<typeof openAgent>>;

const settle = <T>(work: Promise<T>, ms: number) =>
  Promise.race([
    work.then(
      (value) => ({ status: "settled" as const, value }),
      (error: unknown) => ({
        status: "rejected" as const,
        message: error instanceof Error ? error.message : String(error),
      }),
    ),
    scheduler.wait(ms).then(() => ({ status: "timeout" as const })),
  ]);

const stopReasonOf = (outcome: Awaited<ReturnType<typeof settle>>) =>
  outcome.status === "settled" ? (outcome.value as { stopReason?: string }).stopReason : outcome.status;

const promptText = async (agent: Agent, sessionId: string, text: string) => {
  const collected = { text: "" };
  agent.sink.onUpdate = (update) => {
    if (update.sessionUpdate === "agent_message_chunk") collected.text += textOf(update);
  };
  const outcome = await settle(
    agent.connection.prompt({ sessionId, prompt: [{ type: "text", text }] }),
    TURN_CAP_MS,
  );
  agent.sink.onUpdate = () => {};
  return { text: collected.text.trim(), stopReason: stopReasonOf(outcome) };
};

const driveStepTurn = async (agent: Agent, sessionId: string, arm: Arm) => {
  const seen = { completedTools: 0, text: "", stopped: false };
  const reached = Promise.withResolvers<void>();

  agent.sink.onUpdate = (update) => {
    if (update.sessionUpdate === "agent_message_chunk") seen.text += textOf(update);
    if (
      update.sessionUpdate === "tool_call_update" &&
      (update as { status?: string }).status === "completed"
    ) {
      seen.completedTools += 1;
    }
    if (seen.stopped || seen.completedTools < STOP_AFTER_TOOLS) return;
    seen.stopped = true;
    reached.resolve();
  };

  const settled = settle(
    agent.connection.prompt({ sessionId, prompt: [{ type: "text", text: STEP_PROMPT }] }),
    TURN_CAP_MS,
  );
  const outcome = (stopReason: string | undefined, trigger: string) => ({
    stopReason,
    trigger,
    partialText: seen.text.trim(),
    completedTools: seen.completedTools,
  });

  if (arm === "completed") return outcome(stopReasonOf(await settled), "turn-ended");

  // Must race the turn too: a turn that ends under the threshold would otherwise be stopped
  // after the cap and recorded as an interruption that never happened.
  const trigger = await Promise.race([
    reached.promise.then(() => "tool-threshold"),
    settled.then(() => "turn-ended"),
  ]);
  console.log(`  [stop trigger] ${trigger} completedTools=${seen.completedTools} arm=${arm}`);
  if (trigger === "turn-ended") return outcome(stopReasonOf(await settled), trigger);

  if (arm === "cancelled") {
    await agent.connection.cancel({ sessionId });
    return outcome(stopReasonOf(await settled), trigger);
  }

  agent.proc.kill("SIGKILL");
  await scheduler.wait(SETTLE_MS);
  return outcome("sigkill", trigger);
};

const countKinds = (updates: ReadonlyArray<Update>) =>
  updates.reduce<Record<string, number>>((acc, update) => {
    acc[update.sessionUpdate] = (acc[update.sessionUpdate] ?? 0) + 1;
    return acc;
  }, {});

const summarizeReplay = (updates: ReadonlyArray<Update>) => {
  const userText = updates
    .filter((u) => u.sessionUpdate === "user_message_chunk")
    .map(textOf)
    .join("");
  const assistantText = updates
    .filter((u) => u.sessionUpdate === "agent_message_chunk")
    .map(textOf)
    .join("");
  const toolCalls = updates
    .filter((u) => u.sessionUpdate === "tool_call")
    .map((u) => (u as { title?: string; rawInput?: unknown }).title ?? "(untitled)");
  return {
    count: updates.length,
    kinds: countKinds(updates),
    userText,
    assistantText,
    toolCalls,
    replayedStepPrompt: /five steps/i.test(userText),
    replayedPartialAssistant: /STEP \d DONE/i.test(assistantText),
    replayedToolCalls: toolCalls.length,
  };
};

type StoreSnapshot = ReturnType<typeof storeSnapshot>;

const describeStore = (before: StoreSnapshot, after: StoreSnapshot) => {
  if (!before.ok) return `unreadable before (${before.error})`;
  if (!after.ok) return `unreadable after (${after.error})`;
  return `plant.blobs=${before.blobCount} stop.blobs=${after.blobCount} rootAdvanced=${before.rootBlobId !== after.rootBlobId}`;
};

const rootAdvanced = (before: StoreSnapshot, after: StoreSnapshot) =>
  before.ok && after.ok ? before.rootBlobId !== after.rootBlobId : undefined;

const runArm = async (arm: Arm) => {
  const dir = scratch();
  console.log(`\n=== ARM: ${arm} ===\nscratch: ${dir}`);
  const spawned: Agent[] = [];
  const open = async () => {
    const agent = await openAgent(dir);
    spawned.push(agent);
    return agent;
  };

  try {
    return await measure(arm, dir, open);
  } finally {
    for (const agent of spawned) agent.proc.kill("SIGKILL");
  }
};

const measure = async (arm: Arm, dir: string, open: () => Promise<Agent>) => {
  const first = await open();
  const session = await first.connection.newSession({ cwd: dir, mcpServers: [] });
  console.log(`session/new: ${session.sessionId}`);
  console.log(`  loadSession capability: ${first.init.agentCapabilities?.loadSession}`);

  const plant = await promptText(first, session.sessionId, PLANT_PROMPT);
  console.log(`  [turn 1] stopReason=${plant.stopReason} text=${plant.text.slice(0, 60)}`);
  const storeAfterPlant = storeSnapshot(session.sessionId);

  const step = await driveStepTurn(first, session.sessionId, arm);
  console.log(`  [turn 2] stopReason=${step.stopReason} completedTools=${step.completedTools}`);
  const storeAfterStop = storeSnapshot(session.sessionId);
  const filesAfterStop = stepFiles(dir);
  console.log(`  files after stop: ${filesAfterStop.map((f) => f.name).join(", ") || "(none)"}`);
  console.log(`  store: ${describeStore(storeAfterPlant, storeAfterStop)}`);

  first.proc.kill("SIGKILL");
  await scheduler.wait(SETTLE_MS);

  const second = await open();
  const replayed: Update[] = [];
  second.sink.onUpdate = (update) => replayed.push(update);
  const load = await second.connection
    .loadSession({ sessionId: session.sessionId, cwd: dir, mcpServers: [] })
    .then(() => ({ ok: true as const }))
    .catch((error: unknown) => ({
      ok: false as const,
      code: error instanceof RequestError ? error.code : undefined,
      message: error instanceof Error ? error.message : String(error),
    }));
  await scheduler.wait(REPLAY_DRAIN_MS);
  second.sink.onUpdate = () => {};

  const replay = summarizeReplay(replayed);
  console.log(
    `  session/load ok=${load.ok} replayUpdates=${replay.count} kinds=${JSON.stringify(replay.kinds)}`,
  );
  console.log(
    `  replay: stepPrompt=${replay.replayedStepPrompt} partialAssistant=${replay.replayedPartialAssistant} toolCalls=${replay.replayedToolCalls}`,
  );

  const askResumed = (text: string) =>
    load.ok
      ? promptText(second, session.sessionId, text)
      : Promise.resolve({ text: "(skipped — load failed)", stopReason: "skipped" });

  const recall = await askResumed(RECALL_PROMPT);
  console.log(`  [recall] ${recall.text.replace(/\n/g, " | ").slice(0, 200)}`);

  const nudge = await askResumed(NUDGE_PROMPT);
  console.log(`  [nudge] ${nudge.text.replace(/\n/g, " | ").slice(0, 300)}`);

  const filesAfterNudge = stepFiles(dir);
  const stopByName = new Map(filesAfterStop.map((f) => [f.name, f.mtimeMs]));
  const rewritten = filesAfterNudge.filter(
    (f) => stopByName.has(f.name) && stopByName.get(f.name) !== f.mtimeMs,
  );
  console.log(`  files after nudge: ${filesAfterNudge.map((f) => f.name).join(", ") || "(none)"}`);
  console.log(`  rewritten pre-existing files: ${rewritten.map((f) => f.name).join(", ") || "(none)"}`);

  return {
    arm,
    scratchDir: dir,
    sessionId: session.sessionId,
    turn1: plant,
    turn2: step,
    store: { afterPlant: storeAfterPlant, afterStop: storeAfterStop },
    filesAfterStop,
    resume: { load, replay, recall, nudge },
    filesAfterNudge,
    findings: {
      loadSucceeded: load.ok,
      stopTrigger: step.trigger,
      storeRootAdvancedDuringTurn: rootAdvanced(storeAfterPlant, storeAfterStop),
      codewordRecalled: /peridot/i.test(recall.text),
      taskRecalled: /step|five|file/i.test(recall.text.split("\n").slice(1).join(" ")),
      replayedStepPrompt: replay.replayedStepPrompt,
      replayedPartialAssistant: replay.replayedPartialAssistant,
      replayedToolCalls: replay.replayedToolCalls,
      filesBeforeResume: filesAfterStop.length,
      filesAfterResume: filesAfterNudge.length,
      redidCompletedWork: rewritten.length > 0,
      taskFinishedAfterNudge: filesAfterNudge.length === 5,
    },
  };
};

const main = async () => {
  console.log(`model=${MODEL} agent=${AGENT_BIN} arms=${selectedArms.join(",")}`);
  console.log(`cli: ${execFileSync(AGENT_BIN, ["--version"]).toString().trim()}`);

  const results = [];
  for (const arm of selectedArms) {
    results.push(await runArm(arm));
  }

  const summary = {
    model: MODEL,
    cli: execFileSync(AGENT_BIN, ["--version"]).toString().trim(),
    stopAfterTools: STOP_AFTER_TOOLS,
    arms: results,
  };
  writeFileSync(join(import.meta.dirname, "resume-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\n=== FINDINGS ===`);
  for (const result of results) {
    console.log(`${result.arm}: ${JSON.stringify(result.findings)}`);
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
