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

class FakeCursorAgent {
  constructor(connection) {
    this.connection = connection;
  }

  initialize(params) {
    return Promise.resolve({
      protocolVersion: params.protocolVersion,
      agentCapabilities: { loadSession: false },
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
    return Promise.resolve({});
  }

  newSession() {
    return Promise.resolve({ sessionId: "fake-cursor-session" });
  }

  async prompt(params) {
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: process.argv.includes("--malformed") ? "Disposition: ready-for-agent" : result,
        },
      },
    });
    return { stopReason: "end_turn" };
  }

  cancel() {
    return Promise.resolve();
  }
}

const input = Writable.toWeb(process.stdout);
const output = Readable.toWeb(process.stdin);
const stream = acp.ndJsonStream(input, output);
new acp.AgentSideConnection((connection) => new FakeCursorAgent(connection), stream);
