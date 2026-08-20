import { ndJsonStream } from "@agentclientprotocol/sdk";
import { AgUiEvent, type HarnessName } from "@cogwork/contracts";
import { Harness, SessionStore } from "@cogwork/engine";
import { chat, EventType, type StreamChunk } from "@tanstack/ai";
import {
  type AcpHarnessContext,
  type AcpJsonRpcStream,
  type AcpSessionTransport,
  acpCompatible,
  spawnHandleToAcpTransport,
} from "@tanstack/ai-acp";
import {
  bearer,
  createSecrets,
  defineSandbox,
  defineWorkspace,
  mcpSkill,
  type Secrets,
  withSandbox,
} from "@tanstack/ai-sandbox";
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { cursorModelFlag } from "./model";

export interface CursorRunnerOptions {
  readonly name: HarnessName;
  readonly agentBin?: string;
  readonly defaultModel?: string;
  readonly scrubEnv?: ReadonlyArray<string>;
  readonly authMethodId?: string;
}

type CursorModelOptions = {
  readonly sessionId?: string;
  readonly effort?: string;
};

// Cursor keeps conversation history server-side; the opaque handle is how you resume it.
export const cursorModelOptions = (handle: string | null, effort: string | null) => ({
  ...(handle ? { sessionId: handle } : {}),
  ...(effort ? { effort } : {}),
});

const secretName = (name: string) => `MCP_${name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_BEARER`;

const skillConfig = (secrets: Secrets, skill: Harness.ResolvedMcpSkill) => {
  const ref = skill.bearer === null ? undefined : secrets[secretName(skill.name)];
  if (!ref) return { url: skill.endpoint };
  return { url: skill.endpoint, headers: { Authorization: bearer(ref) } };
};

// A skill's bearer travels behind a TanStack `SecretRef`, not as a header string, so the token lands
// in the sandbox env at projection time and never in a snapshot, the sandbox store, or the event log.
export const mcpWorkspaceProjection = (skills: ReadonlyArray<Harness.ResolvedMcpSkill>) => {
  const secretValues = Object.fromEntries(
    skills.flatMap((skill) =>
      skill.bearer === null ? [] : [[secretName(skill.name), Redacted.value(skill.bearer)] as const],
    ),
  );
  const secrets = createSecrets(secretValues);
  const projected = skills.map((skill) => mcpSkill(skill.name, skillConfig(secrets, skill)));
  return { skills: projected, secrets, hasSecrets: Object.keys(secretValues).length > 0 };
};

const decodeEvent = Schema.decodeUnknownOption(AgUiEvent);

export const toEvent = (chunk: StreamChunk): AgUiEvent =>
  Option.getOrElse(decodeEvent(chunk), () => ({ type: chunk.type }));

const launchPattern = /ENOENT|EACCES|spawn|not found|command not found/i;

const fromThrown = (error: unknown): Harness.HarnessError => {
  const message = error instanceof Error ? error.message : String(error);
  const launch = launchPattern.test(message);
  return new Harness.HarnessError({ reason: launch ? "launch" : "turn", retryable: !launch, message });
};

const fromRunError = (chunk: Extract<StreamChunk, { type: EventType.RUN_ERROR }>): Harness.HarnessError =>
  new Harness.HarnessError({ reason: "turn", retryable: true, message: chunk.message });

const bridge = (stream: AsyncIterable<StreamChunk>) =>
  Stream.fromAsyncIterable(stream, fromThrown).pipe(
    Stream.flatMap((chunk) =>
      chunk.type === EventType.RUN_ERROR
        ? Stream.concat(Stream.succeed(toEvent(chunk)), Stream.fail(fromRunError(chunk)))
        : Stream.succeed(toEvent(chunk)),
    ),
  );

export const estimateTokens = (chars: number) => Math.ceil(chars / 4);

const outputChars = (event: AgUiEvent) =>
  event.type === "TEXT_MESSAGE_CONTENT" || event.type === "REASONING_MESSAGE_CONTENT"
    ? (event.delta?.length ?? 0)
    : 0;

// Cursor's `agent acp` never reports token usage — the ACP prompt response is `{stopReason}`
// with no `usage`, and no session update carries counts (see FINDINGS.md Q2) — so without an
// estimate a completed run records nothing.
export const estimatedUsage = (promptChars: number, outputTextChars: number) => {
  const promptTokens = estimateTokens(promptChars);
  const completionTokens = estimateTokens(outputTextChars);
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    estimated: true,
  };
};

export const withEstimatedUsage = (
  promptChars: number,
  stream: Stream.Stream<AgUiEvent, Harness.HarnessError>,
) =>
  Stream.mapAccum(
    stream,
    () => 0,
    (streamed: number, event: AgUiEvent): readonly [number, ReadonlyArray<AgUiEvent>] => {
      const next = streamed + outputChars(event);
      const emit: AgUiEvent =
        event.type === "RUN_FINISHED" && !event.usage
          ? { ...event, usage: estimatedUsage(promptChars, next) }
          : event;
      return [next, [emit]];
    },
  );

type AcpMessage = AcpJsonRpcStream extends { readable: ReadableStream<infer Message> } ? Message : never;

// Cursor's agent sends these vendor JSON-RPC requests to report completed
// tool calls (subagents, todo updates) it already ran in-process, then ignores
// our reply. `@tanstack/ai-acp`'s client has no handler for them, so the ACP SDK
// refuses each with -32601 and logs it. We ack them with an empty result so the
// noise stops without touching the package.
const swallowedCursorMethods = new Set<string>(["cursor/task", "cursor/update_todos"]);

const interceptCursorTelemetry = (base: AcpJsonRpcStream): AcpJsonRpcStream => {
  const writer = base.writable.getWriter();
  const outbound = { tail: Promise.resolve() };
  const send = (message: AcpMessage) => {
    const write = outbound.tail.then(() => writer.write(message));
    outbound.tail = write.then(
      () => undefined,
      () => undefined,
    );
    return write;
  };

  const readable = new ReadableStream<AcpMessage>({
    // @effect-diagnostics-next-line asyncFunction:off
    async start(controller) {
      const reader = base.readable.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if ("method" in value && "id" in value && swallowedCursorMethods.has(value.method)) {
            void send({ jsonrpc: "2.0", id: value.id, result: {} });
            continue;
          }
          controller.enqueue(value);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    },
  });

  const writable = new WritableStream<AcpMessage>({
    write: (message) => send(message),
    close: () => writer.close(),
    abort: (reason) => writer.abort(reason),
  });

  return { readable, writable };
};

const openCursorTransport =
  (agentBin: string) =>
  // @effect-diagnostics-next-line asyncFunction:off
  async (ctx: AcpHarnessContext<CursorModelOptions>): Promise<AcpSessionTransport> => {
    const flag = cursorModelFlag(ctx.model, ctx.modelOptions?.effort);
    const handle = await ctx.sandbox.process.spawn(`${agentBin} --model ${flag} acp`, {
      cwd: ctx.cwd,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    const bytes = spawnHandleToAcpTransport(handle);
    return {
      kind: "stream",
      stream: interceptCursorTelemetry(ndJsonStream(bytes.writable, bytes.readable)),
      dispose: () => bytes.kill(),
      stderrTail: bytes.stderrTail,
    };
  };

export const cursorRunner = (options: CursorRunnerOptions): Harness.HarnessRunner => {
  const agentBin = options.agentBin ?? "agent";
  const defaultModel = options.defaultModel ?? "auto";
  const scrubEnv = [...(options.scrubEnv ?? ["GITHUB_TOKEN", "GH_TOKEN"])];
  const authMethodId = options.authMethodId ?? "cursor_login";
  return {
    name: options.name,
    sessionKind: "opaque-handle",
    run: (request) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const store = yield* SessionStore.SessionStore;
          const handle = request.session ? yield* store.resumeHandle(request.session) : null;
          const model = request.model ?? defaultModel;
          const emptyModelOptions: CursorModelOptions = {};
          const adapter = acpCompatible({
            name: options.name,
            models: [model],
            modelOptions: emptyModelOptions,
            openTransport: openCursorTransport(agentBin),
            planEventName: `${options.name}.plan`,
            authMethodId,
          });
          const projection = mcpWorkspaceProjection(request.mcpSkills);
          const sandbox = defineSandbox({
            id: `cogwork-${options.name}`,
            provider: localProcessSandbox({ dir: request.checkoutPath, scrubEnv }),
            workspace: defineWorkspace({
              source: { type: "none" },
              ...(projection.skills.length > 0 ? { skills: [...projection.skills] } : {}),
              ...(projection.hasSecrets ? { secrets: projection.secrets } : {}),
            }),
          });
          const modelOptions = cursorModelOptions(handle, request.effort);
          const stream = chat({
            adapter: adapter(model),
            messages: [{ role: "user", content: request.prompt }],
            middleware: [withSandbox(sandbox)],
            ...(handle || request.effort ? { modelOptions } : {}),
            outputSchema: Harness.stageResultSchema(request.stage),
            stream: true,
          });
          return withEstimatedUsage(request.prompt.length, bridge(stream));
        }),
      ),
  };
};
