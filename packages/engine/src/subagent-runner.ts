import { type AgUiEvent, type ModelLevel, RunPlanSubagent, TrimmedNonEmptyString } from "@cogwork/contracts";
import {
  type AgentLoopStrategy,
  type AnyTool,
  type ChatMiddleware,
  createSubagentId,
  createSubagentSink,
  type DefinedAgent,
  defineAgent,
  EventType,
  fromSpecTokenUsage,
  runAgentStream,
  type StreamChunk,
  SubagentBudget,
  type SubagentLimits,
  type TokenUsage,
  toolDefinition,
} from "@tanstack/ai";
import type { AnyTextAdapter } from "@tanstack/ai/adapters";
import type * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { toEvent } from "./provider-bridge";
import { mergeBeforeRunFinished } from "./tools/merge-before-run-finished";

class SubagentFailure extends Data.TaggedError("SubagentFailure")<{ readonly message: string }> {}

export type AvailableSubagent = typeof RunPlanSubagent.cases.Available.Type;

export type ModelLevels<Model extends string = string> = Partial<Record<ModelLevel, Model>>;

export interface SubagentTask {
  readonly task: string;
  readonly subagent: AvailableSubagent;
}

export interface SubagentChoice {
  readonly adapter: AnyTextAdapter;
  readonly model: string;
}

export type SubagentRunner = (task: SubagentTask) => SubagentChoice;

export interface SubagentParent {
  readonly runId: string;
  readonly threadId: string;
  readonly tools: ReadonlyArray<AnyTool>;
}

export interface SubagentChild {
  readonly tools: ReadonlyArray<AnyTool>;
  readonly middleware: ReadonlyArray<ChatMiddleware>;
  readonly agentLoopStrategy?: AgentLoopStrategy;
}

export type SubagentFeed = Queue.Queue<AgUiEvent, Cause.Done>;

export const makeSubagentFeed = Queue.unbounded<AgUiEvent, Cause.Done>();

export const mergeSubagentFeed = <E>(harnessEvents: Stream.Stream<AgUiEvent, E>, feed: SubagentFeed) =>
  Stream.unwrap(
    mergeBeforeRunFinished(harnessEvents.pipe(Stream.ensuring(Queue.end(feed))), () =>
      Stream.fromQueue(feed),
    ),
  );

export const childTimeout = Duration.minutes(10);

export const subagentLimits = {
  maxDepth: 1,
  maxCalls: 8,
  maxConcurrent: 3,
} satisfies SubagentLimits;

export const availableSubagents = (subagents: ReadonlyArray<RunPlanSubagent>) =>
  subagents.filter(RunPlanSubagent.guards.Available);

// TanStack's `defineAgent` refuses the name `main`.
const reservedAgentName = "main";

const withoutTakenNames = (subagents: ReadonlyArray<AvailableSubagent>, tools: ReadonlyArray<AnyTool>) => {
  const taken = new Set([reservedAgentName, ...tools.map(({ name }) => name)]);
  return subagents.filter(({ name }) => !taken.has(name));
};

export const levelModel = (levels: ModelLevels, parentModel: string, level: ModelLevel) =>
  levels[level] ?? parentModel;

export const modelLevelRunner =
  (levels: ModelLevels, parentModel: string, adapterFor: (model: string) => AnyTextAdapter): SubagentRunner =>
  ({ subagent }) => {
    const model = levelModel(levels, parentModel, subagent.modelLevel);
    return { adapter: adapterFor(model), model };
  };

const SubagentInput = Schema.Struct({
  task: TrimmedNonEmptyString.annotate({
    description: "The whole task for the Subagent. It sees only this text.",
  }),
});
const inputSchema = Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(SubagentInput));

const ownUsage = (usage: Extract<StreamChunk, { type: EventType.RUN_FINISHED }>["usage"]) =>
  Array.isArray(usage) ? fromSpecTokenUsage(usage) : usage;

const sumUsage = (usages: ReadonlyArray<TokenUsage>) => ({
  promptTokens: usages.reduce((total, usage) => total + usage.promptTokens, 0),
  completionTokens: usages.reduce((total, usage) => total + usage.completionTokens, 0),
  totalTokens: usages.reduce((total, usage) => total + usage.totalTokens, 0),
});

const childText = (chunks: ReadonlyArray<StreamChunk>) =>
  chunks.flatMap((chunk) => (chunk.type === EventType.TEXT_MESSAGE_CONTENT ? [chunk.delta] : [])).join("");

const childError = (chunks: ReadonlyArray<StreamChunk>) =>
  chunks.flatMap((chunk) => (chunk.type === "SUBAGENT_ERROR" ? [chunk.message] : [])).at(0);

// TanStack's `chat({ subagents })` does not fit a Run. It refuses an `outputSchema`, and every
// workflow Run has one. On Claude Code and Codex the parent's tools run through the MCP tool
// bridge, which gives a tool no channel for child events. So each Subagent is a TanStack agent
// that an ordinary tool starts with `runAgentStream`.
export const subagentProjection = (
  subagents: ReadonlyArray<AvailableSubagent>,
  parent: SubagentParent,
  runner: SubagentRunner,
  child: SubagentChild,
  feed: Queue.Enqueue<AgUiEvent, Cause.Done>,
) => {
  const budget = SubagentBudget.root(subagentLimits);
  const running = new Set<object>();
  const sink = createSubagentSink();
  const agentFor = (subagent: AvailableSubagent) =>
    defineAgent({
      name: subagent.name,
      description: subagent.description,
      inputSchema,
      run: (context) =>
        context.chat({
          adapter: runner({ task: context.input.task, subagent }).adapter,
          messages: [{ role: "user", content: context.input.task }],
          systemPrompts: [subagent.prompt],
          tools: [...child.tools],
          middleware: [...child.middleware],
          ...(child.agentLoopStrategy === undefined ? {} : { agentLoopStrategy: child.agentLoopStrategy }),
          debug: false,
          stream: true,
        }),
    });
  const forward = (chunk: StreamChunk) => {
    Queue.offerUnsafe(feed, toEvent(chunk));
    return chunk;
  };
  const childChunks = (
    agent: DefinedAgent,
    task: string,
    toolCallId: string | undefined,
    abortSignal: AbortSignal,
  ) => {
    const subagentRunId = createSubagentId();
    return Array.fromAsync(
      runAgentStream(
        agent,
        {
          input: { task },
          messages: [],
          abortSignal,
          threadId: `${parent.threadId}:${agent.name}`,
          runId: `${parent.runId}:${subagentRunId}`,
          parentRunId: parent.runId,
          subagentRunId,
        },
        sink,
        toolCallId,
      ),
      forward,
    );
  };
  const runChild = Effect.fn("SubagentRunner.runChild")(function* (
    agent: DefinedAgent,
    task: string,
    toolCallId: string | undefined,
  ) {
    const refusal = budget.reserve(running.size);
    if (refusal !== undefined) return yield* new SubagentFailure({ message: refusal });
    const chunks = yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const call = {};
        running.add(call);
        return call;
      }),
      () =>
        Effect.tryPromise({
          try: (signal) => childChunks(agent, task, toolCallId, signal),
          catch: (cause) => new SubagentFailure({ message: `${agent.name} failed: ${String(cause)}` }),
        }).pipe(
          Effect.timeoutOrElse({
            duration: childTimeout,
            orElse: () =>
              Effect.fail(
                new SubagentFailure({
                  message: `${agent.name} ran past ${Duration.format(childTimeout)}`,
                }),
              ),
          }),
        ),
      (call) => Effect.sync(() => running.delete(call)),
    );
    const error = childError(chunks);
    if (error !== undefined) return yield* new SubagentFailure({ message: `${agent.name} failed: ${error}` });
    return childText(chunks);
  });
  const tools = withoutTakenNames(subagents, parent.tools)
    .map(agentFor)
    .map((agent) =>
      toolDefinition({ name: agent.name, description: agent.description, inputSchema }).server(
        ({ task }, context) =>
          Effect.runPromise(runChild(agent, task, context?.toolCallId), {
            ...(context?.abortSignal ? { signal: context.abortSignal } : {}),
          }),
      ),
    );
  const addChildUsage: ChatMiddleware = {
    name: "cogwork-subagent-usage-total",
    onChunk: (_context, chunk) => {
      if (chunk.type !== EventType.RUN_FINISHED || sink.total === undefined) return;
      const own = ownUsage(chunk.usage);
      const children = sink.total;
      sink.total = undefined;
      sink.usage.length = 0;
      return { ...chunk, usage: sumUsage([...(own ? [own] : []), children]) };
    },
  };
  return { tools, middleware: [addChildUsage] };
};
