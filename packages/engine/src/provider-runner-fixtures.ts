import { HarnessName, RunPlan, type RunPlanSubagent, SessionId } from "@cogwork/contracts";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { EventType, InMemoryRunStore, type ModelMessage, type StreamChunk } from "@tanstack/ai";
import {
  type ChatWithInterruptsPersistence,
  defineAIPersistence,
  memoryPersistence,
} from "@tanstack/ai-persistence";
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process";
import type { AnyTextAdapter } from "@tanstack/ai/adapters";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { ContextAssembler, type ContextAssemblerService, type InstructionLayer } from "./context-assembler";
import { CredentialError, CredentialStore, type CredentialStoreService } from "./credential-store";
import type { HarnessRequest } from "./harness";
import type { RunChat, RunChatOptions } from "./provider-runner";
import { SessionStore, type SessionStoreService } from "./session-store";

export const SECRET = "sk-super-secret-value";
export const harnessName = Schema.decodeSync(HarnessName)("provider");
export const sessionId = Schema.decodeSync(SessionId)("sess-resume-1");

export const sampleLayer: InstructionLayer = {
  kind: "operating-instructions",
  source: "/operating-instructions/implement-agent/INSTRUCTIONS.md",
  content: "Follow the implement playbook.",
};

export const toAsyncIterable = <A>(items: ReadonlyArray<A>): AsyncIterable<A> => {
  const iterator = items[Symbol.iterator]();
  return {
    [Symbol.asyncIterator]: (): AsyncIterator<A> => ({ next: () => Promise.resolve(iterator.next()) }),
  };
};

export const scriptedChunks: ReadonlyArray<StreamChunk> = [
  { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "hello world" },
  { type: EventType.RUN_FINISHED, threadId: "t1", runId: "r1" },
];

export const scriptedRunChat =
  (exercise: (options: RunChatOptions) => Promise<void>): RunChat =>
  (options) => {
    const iterator = exercise(options).then(() => toAsyncIterable(scriptedChunks)[Symbol.asyncIterator]());
    return {
      [Symbol.asyncIterator]: () => ({ next: () => iterator.then((current) => current.next()) }),
    };
  };

const structuredTriageJson = '{"_tag":"triage","role":"ready-for-agent","proposal":"Verified and ready."}';

export const nativeStructuredAdapter = {
  kind: "text",
  name: "fake",
  model: "fake",
  "~types": {
    providerOptions: {},
    inputModalities: ["text"],
    messageMetadataByModality: {},
    toolCapabilities: [],
    toolCallMetadata: undefined,
    systemPromptMetadata: undefined,
  },
  chatStream: () =>
    toAsyncIterable<StreamChunk>([
      { type: EventType.RUN_STARTED, runId: "r1", threadId: "t1" },
      { type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: structuredTriageJson },
      { type: EventType.TEXT_MESSAGE_END, messageId: "m1" },
      { type: EventType.RUN_FINISHED, threadId: "t1", runId: "r1", finishReason: "stop" },
    ]),
  structuredOutput: () => Promise.reject(new Error("unexpected structured finalization")),
  supportsCombinedToolsAndSchema: () => true,
} satisfies AnyTextAdapter;

const unexpected = () => Effect.die(new Error("credential store method not expected in this test"));

const credentialStore = (providerKey: CredentialStoreService["providerKey"]): CredentialStoreService => ({
  bearerToken: unexpected,
  resolveSource: unexpected,
  persist: unexpected,
  invalidate: () => Effect.void,
  providerKey,
  persistProviderKey: unexpected,
  configureConnection: unexpected,
  removeConnection: unexpected,
});

export const credentialLayer = (providerKey: CredentialStoreService["providerKey"]) =>
  Layer.succeed(CredentialStore, credentialStore(providerKey));

export const keyProvider: CredentialStoreService["providerKey"] = () =>
  Effect.succeed({ source: "env", key: Redacted.make(SECRET) });

export const missingKeyProvider: CredentialStoreService["providerKey"] = () =>
  Effect.fail(new CredentialError({ account: "openai", message: "no api key for openai", retryable: false }));

const stubPersistence = (thread: ReadonlyArray<ModelMessage>): ChatWithInterruptsPersistence =>
  defineAIPersistence({
    stores: {
      messages: {
        loadThread: () => Promise.resolve([...thread]),
        saveThread: () => Promise.resolve(),
      },
      runs: new InMemoryRunStore(),
      interrupts: memoryPersistence().stores.interrupts,
    },
  });

const sessionStore = (thread: ReadonlyArray<ModelMessage>): SessionStoreService => ({
  persistence: stubPersistence(thread),
  resumeHandle: () => Effect.succeed(null),
  mint: () => Effect.die(new Error("mint not expected in this test")),
});

export const sessionLayer = (thread: ReadonlyArray<ModelMessage>) =>
  Layer.succeed(SessionStore, sessionStore(thread));

const contextService = (layers: ReadonlyArray<InstructionLayer>): ContextAssemblerService => ({
  assemble: () =>
    Effect.succeed({
      layers,
      operatingInstructionsName: "implement-agent",
      operatingInstructionsPath: "/operating-instructions/implement-agent",
      operatingInstructionResources: [],
      sources: [],
    }),
  cleanup: () => Effect.void,
});

const contextLayer = (layers: ReadonlyArray<InstructionLayer>) =>
  Layer.succeed(ContextAssembler, contextService(layers));

interface RequestOverrides {
  readonly checkoutPath?: string | null;
  readonly session?: HarnessRequest["session"];
  readonly operation?: string;
  readonly model?: string;
  readonly subagents?: ReadonlyArray<RunPlanSubagent>;
}

export const request = (overrides: RequestOverrides): HarnessRequest => {
  const operation = overrides.operation ?? "operate";
  const profile = operation === "triage" ? "read-only" : "full";
  const structuredOutput = { type: "object" as const };
  return {
    plan: Schema.decodeSync(RunPlan)({
      id: "run-provider-test",
      operation,
      harness: { name: harnessName, model: overrides.model ?? "openai/gpt-4o", options: {}, profile },
      instructions: [{ ...sampleLayer, kind: "repo" }],
      operatingInstructions: {
        name: "implement-agent",
        path: "/operating-instructions/implement-agent",
        resources: [{ source: "/operating-instructions/implement-agent/GUIDE.md", content: "guide" }],
      },
      tools: ["read", "write", "edit", "bash", "glob", "grep", "webfetch"],
      skills: [],
      mcp: [],
      subagents: overrides.subagents ?? [],
      hooks: [],
      middleware: ["persistence", "instruction-context"],
      structuredOutput,
      connections: [],
      messages: [{ role: "user", content: "do the thing" }],
      workContext: {
        reference: { workItem: "#1", url: null },
        prose: {
          body: "Ship the requested provider change.",
          comments: [
            {
              author: "maintainer",
              authorAssociation: "MEMBER",
              body: "Keep the adapter contract stable.",
              createdAtMillis: 2,
            },
          ],
        },
        facts: { assignees: [], openBlockers: 0, claim: null, priority: "medium" },
        observation: { generation: 1, observedAtMillis: 1 },
      },
      sandbox: {
        workspace: overrides.checkoutPath === undefined ? "/tmp/does-not-matter" : overrides.checkoutPath,
        policy: profile,
      },
      persistence: { sessionKind: "owned-transcript" },
      provenance: {
        resolution: [],
        stamps: [],
        projectedNames: [],
        projection: [],
        observation: { generation: 1, observedAtMillis: 1 },
      },
    }),
    session: "session" in overrides ? (overrides.session ?? null) : sessionId,
    mcpCredentials: new Map(),
  };
};

export const scratchCheckout = Effect.fn("runner.test.scratchCheckout")(function* () {
  const handle = yield* Effect.acquireRelease(
    Effect.promise(() => localProcessSandbox({}).create({})),
    (open) => Effect.promise(() => open.destroy()),
  );
  return handle.id;
});

export const providerRunnerLayer = (
  credentials = credentialLayer(keyProvider),
  httpClient = FetchHttpClient.layer,
) =>
  Layer.mergeAll(
    contextLayer([sampleLayer]),
    credentials,
    sessionLayer([]),
    NodeFileSystem.layer,
    NodePath.layer,
    httpClient,
  );
