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

const promptText = (prompt) =>
  prompt
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");

const responseContent = (sessionParams, prompt) => {
  if (process.argv.includes("--malformed")) return "Disposition: ready-for-agent";
  if (!process.argv.includes("--observe")) return result;
  return JSON.stringify({
    prompt: promptText(prompt),
    model: process.argv[process.argv.indexOf("--model") + 1],
    mcp: sessionParams.mcpServers.map((server) => ({
      name: server.name,
      url: server.url,
      authenticated: server.headers.some((header) => header.name === "Authorization"),
    })),
    cursorConfigDir: process.env.CURSOR_CONFIG_DIR ?? null,
    windowsEnvironment: {
      USERPROFILE: process.env.USERPROFILE ?? null,
      HOMEDRIVE: process.env.HOMEDRIVE ?? null,
      HOMEPATH: process.env.HOMEPATH ?? null,
      APPDATA: process.env.APPDATA ?? null,
      SYSTEMROOT: process.env.SYSTEMROOT ?? null,
      PATHEXT: process.env.PATHEXT ?? null,
      COMSPEC: process.env.COMSPEC ?? null,
    },
    networkEnvironment: {
      HTTP_PROXY: process.env.HTTP_PROXY ?? null,
      HTTPS_PROXY: process.env.HTTPS_PROXY ?? null,
      NO_PROXY: process.env.NO_PROXY ?? null,
      NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY ?? null,
      NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS ?? null,
    },
    hasCursorApiKey: process.env.CURSOR_API_KEY !== undefined,
  });
};

const commandPermissionContent = async (connection, sessionId) => {
  const { outcome } = await connection.requestPermission({
    sessionId,
    toolCall: {
      toolCallId: "fake-command",
      title: "`pnpm typecheck`",
      kind: "execute",
      rawInput: { command: "pnpm typecheck" },
    },
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "reject-once", name: "Reject once", kind: "reject_once" },
    ],
  });
  return JSON.stringify(outcome);
};

class FakeCursorAgent {
  constructor(connection) {
    this.connection = connection;
  }

  initialize(params) {
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
    const content = process.argv.includes("--request-command-permission")
      ? await commandPermissionContent(this.connection, params.sessionId)
      : responseContent(this.sessionParams, params.prompt);
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
