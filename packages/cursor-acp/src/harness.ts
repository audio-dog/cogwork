import { ndJsonStream, RequestError } from "@agentclientprotocol/sdk";
import { AgUiEvent, type HarnessName } from "@cogwork/contracts";
import { Harness, SessionStore } from "@cogwork/engine";
import {
  type ChatMiddleware,
  chat,
  EventType,
  type JSONSchema,
  type ModelMessage,
  type StreamChunk,
} from "@tanstack/ai";
import {
  type AcpCompatibleTextAdapter,
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
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { cursorModelFlag } from "./model";

export interface CursorRunnerOptions {
  readonly name: HarnessName;
  readonly agentBin?: string;
  readonly defaultModel?: string;
  readonly scrubEnv?: ReadonlyArray<string>;
  readonly authMethodId?: string;
  readonly runChat?: CursorRunChat;
}

export type CursorModelOptions = {
  readonly sessionId?: string;
  readonly effort?: string;
};

export interface CursorRunChatOptions {
  readonly adapter: AcpCompatibleTextAdapter<string, CursorModelOptions>;
  readonly messages: ReadonlyArray<ModelMessage>;
  readonly middleware: ReadonlyArray<ChatMiddleware>;
  readonly abortController: AbortController;
  readonly modelOptions?: CursorModelOptions;
  readonly outputSchema?: JSONSchema;
}

export type CursorRunChat = (options: CursorRunChatOptions) => AsyncIterable<StreamChunk>;

const defaultRunChat: CursorRunChat = (options) =>
  chat({
    adapter: options.adapter,
    messages: [...options.messages],
    middleware: [...options.middleware],
    abortController: options.abortController,
    ...(options.modelOptions ? { modelOptions: options.modelOptions } : {}),
    outputSchema: options.outputSchema,
    stream: true,
  });

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

const launchCodes = new Set(["ENOENT", "EACCES"]);

const hasLaunchCode = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof error.code === "string" &&
  launchCodes.has(error.code);

const fromThrown = (error: unknown): Harness.HarnessError => {
  const message = error instanceof Error ? error.message : String(error);
  const launch = error instanceof RequestError || hasLaunchCode(error);
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
  AgUiEvent.guards.TEXT_MESSAGE_CONTENT(event) || AgUiEvent.guards.REASONING_MESSAGE_CONTENT(event)
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

class CursorTransportError extends Data.TaggedError("CursorTransportError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

const transportError = (cause: unknown) =>
  new CursorTransportError({ cause, message: cause instanceof Error ? cause.message : String(cause) });

export const interceptCursorTelemetry = (base: AcpJsonRpcStream): AcpJsonRpcStream => {
  const outbound = Semaphore.makeUnsafe(1);
  const withWriter = <A>(use: (writer: WritableStreamDefaultWriter<AcpMessage>) => Promise<A>) =>
    outbound.withPermit(
      Effect.acquireUseRelease(
        Effect.sync(() => base.writable.getWriter()),
        (writer) => Effect.tryPromise({ try: () => use(writer), catch: transportError }),
        (writer) => Effect.sync(() => writer.releaseLock()),
      ),
    );
  const runWithWriter = <A>(use: (writer: WritableStreamDefaultWriter<AcpMessage>) => Promise<A>) =>
    Effect.runPromise(withWriter(use));

  return {
    readable: Stream.fromReadableStream({
      evaluate: () => base.readable,
      onError: transportError,
    }).pipe(
      Stream.filterEffect((message) => {
        if (!("method" in message && "id" in message && swallowedCursorMethods.has(message.method))) {
          return Effect.succeed(true);
        }
        return withWriter((writer) => writer.write({ jsonrpc: "2.0", id: message.id, result: {} })).pipe(
          Effect.ignore,
          Effect.map(() => false),
        );
      }),
      Stream.toReadableStream(),
    ),
    writable: new WritableStream<AcpMessage>({
      write: (message) => runWithWriter((writer) => writer.write(message)),
      close: () => runWithWriter((writer) => writer.close()),
      abort: (reason) => runWithWriter((writer) => writer.abort(reason)),
    }),
  };
};

const openCursorTransport =
  (agentBin: string) =>
  (ctx: AcpHarnessContext<CursorModelOptions>): Promise<AcpSessionTransport> => {
    const flag = cursorModelFlag(ctx.model, ctx.modelOptions?.effort);
    return ctx.sandbox.process
      .spawn(`${agentBin} --model ${flag} acp`, {
        cwd: ctx.cwd,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      })
      .then((handle) => {
        const bytes = spawnHandleToAcpTransport(handle);
        return {
          kind: "stream",
          stream: interceptCursorTelemetry(ndJsonStream(bytes.writable, bytes.readable)),
          dispose: () => bytes.kill(),
          stderrTail: bytes.stderrTail,
        };
      });
  };

export const cursorRunner = (options: CursorRunnerOptions): Harness.HarnessRunner => {
  const agentBin = options.agentBin ?? "agent";
  const defaultModel = options.defaultModel ?? "auto";
  const scrubEnv = [...(options.scrubEnv ?? ["GITHUB_TOKEN", "GH_TOKEN"])];
  const authMethodId = options.authMethodId ?? "cursor_login";
  const runChat = options.runChat ?? defaultRunChat;
  return {
    name: options.name,
    sessionKind: "opaque-handle",
    projectedMembers: [
      "Harness Adapter",
      "Messages",
      "MCP",
      "Middleware",
      "Sandbox",
      "Structured Output",
      "Persistence",
      "Connections",
    ],
    planMiddleware: ["sandbox"],
    execution: {
      nonInteractive: false,
      worktreeConfined: false,
      profiles: [],
    },
    run: (request) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const plan = request.plan;
          const store = yield* SessionStore.SessionStore;
          const handle = request.session ? yield* store.resumeHandle(request.session) : null;
          const model = plan.harness.model ?? defaultModel;
          const emptyModelOptions: CursorModelOptions = {};
          const adapter = acpCompatible({
            name: options.name,
            models: [model],
            modelOptions: emptyModelOptions,
            openTransport: openCursorTransport(agentBin),
            planEventName: `${options.name}.plan`,
            authMethodId,
          });
          const projection = mcpWorkspaceProjection(Harness.resolvedMcpSkills(request));
          const sandbox = defineSandbox({
            id: `cogwork-${options.name}`,
            fileEvents: false,
            provider: localProcessSandbox({ dir: plan.sandbox.workspace, scrubEnv }),
            workspace: defineWorkspace({
              source: { type: "none" },
              ...(projection.skills.length > 0 ? { skills: [...projection.skills] } : {}),
              ...(projection.hasSecrets ? { secrets: projection.secrets } : {}),
            }),
          });
          const effort = plan.harness.effort;
          const modelOptions = cursorModelOptions(handle, effort);
          const abortController = new AbortController();
          const stream = runChat({
            adapter: adapter(model),
            messages: plan.messages.map(({ role, content }) => ({ role, content })),
            middleware: plan.middleware.includes("sandbox") ? [withSandbox(sandbox)] : [],
            abortController,
            ...(handle || effort ? { modelOptions } : {}),
            outputSchema: plan.structuredOutput ?? undefined,
          });
          const promptLength = plan.messages.reduce((total, message) => total + message.content.length, 0);
          return withEstimatedUsage(promptLength, bridge(stream)).pipe(
            Stream.ensuring(Effect.sync(() => abortController.abort())),
          );
        }),
      ),
  };
};
