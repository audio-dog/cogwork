import { type ModelLevel, RunPlanSubagent, TrimmedNonEmptyString } from "@cogwork/contracts";
import {
  type AgentLoopStrategy,
  type AnyTool,
  type ChatMiddleware,
  chat,
  EventType,
  fromSpecTokenUsage,
  type StreamChunk,
  SubagentBudget,
  type SubagentLimits,
  type TokenUsage,
  toolDefinition,
} from "@tanstack/ai";
import type { AnyTextAdapter } from "@tanstack/ai/adapters";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

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

export interface SubagentChild {
  readonly tools: ReadonlyArray<AnyTool>;
  readonly middleware: ReadonlyArray<ChatMiddleware>;
  readonly agentLoopStrategy?: AgentLoopStrategy;
}

export const childTimeout = Duration.minutes(10);

export const subagentLimits = {
  maxDepth: 1,
  maxCalls: 8,
  maxConcurrent: 3,
} satisfies SubagentLimits;

export const availableSubagents = (subagents: ReadonlyArray<RunPlanSubagent>) =>
  subagents.filter(RunPlanSubagent.guards.Available);

const withoutToolNames = (subagents: ReadonlyArray<AvailableSubagent>, tools: ReadonlyArray<AnyTool>) => {
  const taken = new Set(tools.map(({ name }) => name));
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

// TanStack's `chat({ subagents })` refuses an `outputSchema`, and every workflow Run has one,
// so each Subagent is an ordinary tool that starts its own child `chat()`.
export const subagentProjection = (
  subagents: ReadonlyArray<AvailableSubagent>,
  parentTools: ReadonlyArray<AnyTool>,
  runner: SubagentRunner,
  child: SubagentChild,
) => {
  const budget = SubagentBudget.root(subagentLimits);
  const running = new Set<object>();
  const childUsage: Array<TokenUsage> = [];
  const collectUsage: ChatMiddleware = {
    name: "cogwork-subagent-usage",
    onUsage: (_context, usage) => {
      childUsage.push(usage);
    },
  };
  const childMiddleware: Array<ChatMiddleware> = [...child.middleware, collectUsage];
  const childChat = (subagent: AvailableSubagent, task: string, threadId: string, signal: AbortSignal) => {
    const abortController = new AbortController();
    signal.addEventListener("abort", () => abortController.abort(signal.reason), { once: true });
    return chat({
      adapter: runner({ task, subagent }).adapter,
      messages: [{ role: "user", content: task }],
      systemPrompts: [subagent.prompt],
      tools: [...child.tools],
      middleware: childMiddleware,
      ...(child.agentLoopStrategy === undefined ? {} : { agentLoopStrategy: child.agentLoopStrategy }),
      abortController,
      threadId: `${threadId}:${subagent.name}`,
      debug: false,
      stream: false,
    });
  };
  const runChild = Effect.fn("SubagentRunner.runChild")(function* (
    subagent: AvailableSubagent,
    task: string,
    threadId: string,
  ) {
    const refusal = budget.reserve(running.size);
    if (refusal !== undefined) return yield* new SubagentFailure({ message: refusal });
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const call = {};
        running.add(call);
        return call;
      }),
      () =>
        Effect.tryPromise({
          try: (signal) => childChat(subagent, task, threadId, signal),
          catch: (cause) => new SubagentFailure({ message: `${subagent.name} failed: ${String(cause)}` }),
        }).pipe(
          Effect.timeoutOrElse({
            duration: childTimeout,
            orElse: () =>
              Effect.fail(
                new SubagentFailure({
                  message: `${subagent.name} ran past ${Duration.format(childTimeout)}`,
                }),
              ),
          }),
        ),
      (call) => Effect.sync(() => running.delete(call)),
    );
  });
  const tools = withoutToolNames(subagents, parentTools).map((subagent) =>
    toolDefinition({ name: subagent.name, description: subagent.description, inputSchema }).server(
      ({ task }, context) =>
        Effect.runPromise(runChild(subagent, task, context?.threadId ?? "subagent"), {
          ...(context?.abortSignal ? { signal: context.abortSignal } : {}),
        }),
    ),
  );
  const addChildUsage: ChatMiddleware = {
    name: "cogwork-subagent-usage-total",
    onChunk: (_context, chunk) => {
      if (chunk.type !== EventType.RUN_FINISHED || childUsage.length === 0) return;
      const own = ownUsage(chunk.usage);
      return { ...chunk, usage: sumUsage([...(own ? [own] : []), ...childUsage.splice(0)]) };
    },
  };
  return { tools, middleware: [addChildUsage] };
};
