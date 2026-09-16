import { readFile } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

if (process.argv.includes("--version")) {
  const override = process.argv.find((argument) => argument.startsWith("--fake-version="));
  process.stdout.write(`${override?.slice("--fake-version=".length) ?? "2026.08.11-fake"}\n`);
  process.exit(0);
}

if (process.argv.includes("--list-models")) {
  process.stdout.write("Available models:\nfake-native - Fake native model\nauto - Auto\n");
  process.exit(0);
}

const result = JSON.stringify({
  _tag: "triage",
  role: "ready-for-agent",
  proposal: "Verified and ready.",
});

const responseContent = async (sessionParams) => {
  if (process.argv.includes("--malformed")) return "Disposition: ready-for-agent";
  if (!process.argv.includes("--observe")) return result;
  return JSON.stringify({
    instructions: await readFile("AGENTS.md", "utf8"),
    model: process.argv[process.argv.indexOf("--model") + 1],
    mcp: sessionParams.mcpServers.map((server) => ({
      name: server.name,
      url: server.url,
      authenticated: server.headers.some((header) => header.name === "Authorization"),
    })),
  });
};

const parameterizedModels = {
  models: [
    { value: "auto-smart", name: "Auto" },
    {
      value: "fake-native",
      name: "Fake Native",
      configOptions: [
        {
          id: "effort",
          name: "Effort",
          category: "thought_level",
          type: "select",
          currentValue: "high",
          options: [
            { value: "low", name: "Low" },
            { value: "high", name: "High" },
          ],
        },
        {
          id: "fast",
          name: "Fast",
          category: "model_config",
          type: "select",
          currentValue: "false",
          options: [
            { value: "false", name: "Off" },
            { value: "true", name: "Fast\u200b" },
          ],
        },
      ],
    },
  ],
};

class FakeCursorAgent {
  constructor(connection) {
    this.connection = connection;
  }

  initialize(params) {
    this.parameterizedPicker = params.clientCapabilities?._meta?.parameterizedModelPicker === true;
    return Promise.resolve({
      protocolVersion: params.protocolVersion,
      agentCapabilities: { loadSession: true },
      authMethods: [
        {
          id: "cursor_login",
          name: "Cursor Login",
          description: "Fake Cursor login",
        },
      ],
    });
  }

  extMethod(method) {
    if (method !== "cursor/list_available_models") {
      return Promise.reject(new Error(`unexpected extension method ${method}`));
    }
    if (!this.parameterizedPicker) return Promise.resolve({ models: [] });
    return Promise.resolve(parameterizedModels);
  }

  authenticate() {
    return Promise.reject(new Error("host login must skip ACP authenticate"));
  }

  newSession(params) {
    this.sessionParams = params;
    return Promise.resolve({ sessionId: "fake-cursor-session" });
  }

  loadSession(params) {
    if (process.argv.includes("--reject-load")) return Promise.reject(new Error("session missing"));
    this.sessionParams = params;
    return Promise.resolve({});
  }

  async prompt(params) {
    if (process.argv.includes("--blocking-extension")) {
      const response = this.connection.extMethod("cursor/create_plan", { sessionId: params.sessionId });
      const refused = await response.then(
        () => false,
        (error) => error?.code === -32601,
      );
      if (!refused) throw new Error("cursor/create_plan was not refused with method-not-found");
    }
    const content = await responseContent(this.sessionParams);
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: content,
        },
      },
    });
    return {
      stopReason: "end_turn",
      ...(process.argv.includes("--metered")
        ? { usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } }
        : {}),
    };
  }

  cancel() {
    return Promise.resolve();
  }
}

const input = Writable.toWeb(process.stdout);
const output = Readable.toWeb(process.stdin);
const stream = acp.ndJsonStream(input, output);
new acp.AgentSideConnection((connection) => new FakeCursorAgent(connection), stream);
