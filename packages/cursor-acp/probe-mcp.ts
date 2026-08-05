import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessName, type McpSkill } from "@clanker-forge/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { cursorRunner } from "./src/index";

const MODEL = process.env.PROBE_MODEL ?? "auto";
const AGENT_BIN = process.env.PROBE_AGENT_BIN ?? "agent";
const MCP_NAME = process.env.PROBE_MCP_NAME ?? "deepwiki";
const MCP_URL = process.env.PROBE_MCP_URL ?? "https://mcp.deepwiki.com/mcp";

const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "probe-mcp-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "probe@example.com");
  git("config", "user.name", "probe");
  writeFileSync(join(dir, "NOTES.md"), "# scratch\n");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  return dir;
};

const cursor = Schema.decodeSync(HarnessName)("cursor");

const main = async () => {
  const dir = scratch();
  const skill: McpSkill = { name: MCP_NAME, endpoint: MCP_URL };
  const runner = cursorRunner({ name: cursor, agentBin: AGENT_BIN });

  console.log(`scratch checkout: ${dir}`);
  console.log(`model: ${MODEL}  mcp: ${MCP_NAME} -> ${MCP_URL}\n`);

  const request = {
    harness: cursor,
    checkoutPath: dir,
    prompt: [
      `You have an MCP server named "${MCP_NAME}" attached to this session.`,
      "List the tools it exposes, then call one of them once and report the result.",
      "If you cannot see the server or any of its tools, say NO-MCP and stop.",
    ].join("\n"),
    model: MODEL,
    effort: null,
    sessionId: null,
    mcpSkills: [skill],
  };

  const toolCalls: Array<string> = [];
  const text = { value: "" };

  await Effect.runPromise(
    runner.run(request).pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          if (event.type.includes("TOOL_CALL") && event.name) {
            toolCalls.push(event.name);
            console.log(`  [tool] ${event.name}`);
          }
          if (event.text) text.value += event.text;
        }),
      ),
    ),
  );

  const calledMcpTool = toolCalls.length > 0 && !/NO-MCP/i.test(text.value);
  console.log(`\n=== SUMMARY ===`);
  console.log(
    JSON.stringify(
      { model: MODEL, mcp: { name: MCP_NAME, url: MCP_URL }, toolCalls, calledMcpTool },
      null,
      2,
    ),
  );
  console.log(`\n[assistant] ${text.value.trim().slice(0, 400)}`);
  if (!calledMcpTool) process.exitCode = 1;
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
