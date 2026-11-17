import { RunPlanSubagent } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import { chat, EventType, type StreamChunk, type TextOptions, toolDefinition } from "@tanstack/ai";
import * as Effect from "effect/Effect";
import { type SubagentRunner, type SubagentTask, subagentProjection } from "./subagent-runner";
import {
  hasToolResults,
  type SubagentCall,
  scriptedAdapter,
  subagentCallTurn,
  textTurn,
} from "./testing/scripted-adapter";

const reviewer = RunPlanSubagent.cases.Available.make({
  identity: "local:repo/reviewer",
  name: "reviewer",
  source: ".agents/agents/reviewer.md",
  description: "Reviews one change",
  tools: [],
  modelLevel: "light",
  prompt: "You review changes.",
});

const parentRun = (calls: ReadonlyArray<SubagentCall>, runner: SubagentRunner) => {
  const parent = scriptedAdapter("parent", (options) =>
    hasToolResults(options) ? textTurn('{"outcome":"done"}', 1) : subagentCallTurn(calls, 1),
  );
  const projection = subagentProjection([reviewer], [], runner, { tools: [], middleware: [] });
  return Effect.promise(() =>
    Array.fromAsync(
      chat({
        adapter: parent,
        messages: [{ role: "user", content: "Implement #884." }],
        threadId: "thread-884",
        tools: projection.tools,
        middleware: projection.middleware,
        outputSchema: { type: "object" },
        stream: true,
      }),
    ),
  );
};

const toolResults = (chunks: ReadonlyArray<StreamChunk>) =>
  chunks.flatMap((chunk) =>
    chunk.type === EventType.TOOL_CALL_RESULT && typeof chunk.content === "string" ? [chunk.content] : [],
  );

describe("subagent runner", () => {
  it.effect(
    "starts an admitted Subagent as a child that gets its prompt, the task, and the routed adapter",
    () =>
      Effect.gen(function* () {
        const childCalls: Array<TextOptions> = [];
        const routed: Array<SubagentTask> = [];
        const child = scriptedAdapter("stub-routed", () => textTurn("review passed", 1), childCalls);
        const stubRouter: SubagentRunner = (task) => {
          routed.push(task);
          return { adapter: child, model: "stub-routed" };
        };

        const chunks = yield* parentRun(
          [{ id: "call-1", agent: "reviewer", task: "Check the diff." }],
          stubRouter,
        );

        assert.deepStrictEqual(routed, [{ task: "Check the diff.", subagent: reviewer }]);
        assert.strictEqual(childCalls.length, 1);
        assert.deepStrictEqual(childCalls[0]?.systemPrompts, ["You review changes."]);
        assert.deepStrictEqual(childCalls[0]?.messages.at(-1), { role: "user", content: "Check the diff." });
        assert.include(toolResults(chunks).join(), "review passed");
        assert.strictEqual(chunks.at(-1)?.type, EventType.RUN_FINISHED);
      }),
  );

  it.effect(
    "refuses a start past the concurrency limit as a tool error, and the parent Run still finishes",
    () =>
      Effect.gen(function* () {
        const child = scriptedAdapter("child", () => textTurn("ok", 1));
        const calls = Array.from({ length: 4 }, (_, index) => ({
          id: `call-${index}`,
          agent: "reviewer",
          task: `Task ${index}.`,
        }));

        const chunks = yield* parentRun(calls, () => ({ adapter: child, model: "child" }));

        assert.isTrue(
          toolResults(chunks).some((content) => content.includes("subagent limit reached (maxConcurrent 3)")),
        );
        assert.strictEqual(chunks.at(-1)?.type, EventType.RUN_FINISHED);
      }),
  );

  it("leaves out a Subagent whose name a parent tool already has", () => {
    const reviewTool = toolDefinition({ name: "reviewer", description: "An engine tool" }).server(() =>
      Promise.resolve({}),
    );
    const child = scriptedAdapter("child", () => textTurn("ok", 1));

    const projection = subagentProjection(
      [reviewer],
      [reviewTool],
      () => ({ adapter: child, model: "child" }),
      {
        tools: [],
        middleware: [],
      },
    );

    assert.deepStrictEqual(projection.tools, []);
  });
});
