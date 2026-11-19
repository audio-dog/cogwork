import { type AgUiEvent, agUiTextDelta, RunPlanSubagent } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import { chat, EventType, type StreamChunk, type TextOptions, toolDefinition } from "@tanstack/ai";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import {
  makeSubagentFeed,
  mergeSubagentFeed,
  type SubagentRunner,
  type SubagentTask,
  subagentProjection,
} from "./subagent-runner";
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

const parentRun = (calls: ReadonlyArray<SubagentCall>, runner: SubagentRunner) =>
  Effect.gen(function* () {
    const parent = scriptedAdapter("parent", (options) =>
      hasToolResults(options) ? textTurn('{"outcome":"done"}', 1) : subagentCallTurn(calls, 1),
    );
    const feed = yield* makeSubagentFeed;
    const projection = subagentProjection(
      [reviewer],
      { runId: "run-884", threadId: "thread-884", tools: [] },
      runner,
      { tools: [], middleware: [] },
      feed,
    );
    const chunks = yield* Effect.promise(() =>
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
    yield* Queue.end(feed);
    const childEvents = yield* Stream.runCollect(Stream.fromQueue(feed));
    return { chunks, childEvents };
  });

const byChild = (events: ReadonlyArray<AgUiEvent>) => Map.groupBy(events, (event) => event.subagentRunId);

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

        const { chunks, childEvents } = yield* parentRun(
          [{ id: "call-1", agent: "reviewer", task: "Check the diff." }],
          stubRouter,
        );

        assert.deepStrictEqual(routed, [{ task: "Check the diff.", subagent: reviewer }]);
        assert.strictEqual(childCalls.length, 1);
        assert.deepStrictEqual(childCalls[0]?.systemPrompts, ["You review changes."]);
        assert.deepStrictEqual(childCalls[0]?.messages.at(-1), { role: "user", content: "Check the diff." });
        assert.include(toolResults(chunks).join(), "review passed");
        assert.strictEqual(chunks.at(-1)?.type, EventType.RUN_FINISHED);
        assert.deepStrictEqual(
          childEvents.map(({ type }) => type),
          [
            "SUBAGENT_STARTED",
            "TEXT_MESSAGE_START",
            "TEXT_MESSAGE_CONTENT",
            "TEXT_MESSAGE_END",
            "SUBAGENT_FINISHED",
          ],
        );
        assert.strictEqual(byChild(childEvents).size, 1);
        assert.strictEqual(childEvents[0]?.parentToolCallId, "call-1");
      }),
  );

  it.effect("sends the events of parallel children to the feed, each with its own child's id", () =>
    Effect.gen(function* () {
      const child = scriptedAdapter("child", (options) => {
        const task = options.messages.at(-1)?.content;
        return textTurn(typeof task === "string" ? task : "", 1);
      });

      const { childEvents } = yield* parentRun(
        [
          { id: "call-1", agent: "reviewer", task: "First." },
          { id: "call-2", agent: "reviewer", task: "Second." },
        ],
        () => ({ adapter: child, model: "child" }),
      );

      const children = [...byChild(childEvents).values()];
      assert.sameMembers(
        children.map((events) => events.map(agUiTextDelta).join("")),
        ["First.", "Second."],
      );
      assert.isTrue(
        children.every(
          (events) =>
            events.at(0)?.type === "SUBAGENT_STARTED" && events.at(-1)?.type === "SUBAGENT_FINISHED",
        ),
      );
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

        const { chunks } = yield* parentRun(calls, () => ({ adapter: child, model: "child" }));

        assert.isTrue(
          toolResults(chunks).some((content) => content.includes("subagent limit reached (maxConcurrent 3)")),
        );
        assert.strictEqual(chunks.at(-1)?.type, EventType.RUN_FINISHED);
      }),
  );

  it.effect("gives a failed child to the parent as a tool error, and the parent Run still finishes", () =>
    Effect.gen(function* () {
      const child = scriptedAdapter("child", () => {
        throw new Error("model overloaded");
      });

      const { chunks, childEvents } = yield* parentRun(
        [{ id: "call-1", agent: "reviewer", task: "Check the diff." }],
        () => ({ adapter: child, model: "child" }),
      );

      assert.isTrue(
        toolResults(chunks).some((content) => content.includes("reviewer failed: model overloaded")),
      );
      assert.strictEqual(chunks.at(-1)?.type, EventType.RUN_FINISHED);
      const failed = childEvents.at(-1);
      assert.strictEqual(failed?.type, "SUBAGENT_ERROR");
      assert.strictEqual(failed?.message, "model overloaded");
    }),
  );

  it.effect("leaves out a Subagent whose name a parent tool or TanStack already has", () =>
    Effect.gen(function* () {
      const reviewTool = toolDefinition({ name: "reviewer", description: "An engine tool" }).server(() =>
        Promise.resolve({}),
      );
      const child = scriptedAdapter("child", () => textTurn("ok", 1));

      const projection = subagentProjection(
        [reviewer, RunPlanSubagent.cases.Available.make({ ...reviewer, name: "main" })],
        { runId: "run-884", threadId: "thread-884", tools: [reviewTool] },
        () => ({ adapter: child, model: "child" }),
        { tools: [], middleware: [] },
        yield* makeSubagentFeed,
      );

      assert.deepStrictEqual(projection.tools, []);
    }),
  );
});

describe("mergeSubagentFeed", () => {
  const harnessEvents: ReadonlyArray<AgUiEvent> = [
    { type: "RUN_STARTED", threadId: "thread-983" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "parent text" },
    { type: "RUN_FINISHED", threadId: "thread-983" },
  ];

  it.effect("holds RUN_FINISHED until every child event in the feed has gone out", () =>
    Effect.gen(function* () {
      const feed = yield* makeSubagentFeed;
      const childEvents: ReadonlyArray<AgUiEvent> = [
        { type: "SUBAGENT_STARTED", subagentRunId: "child-1" },
        { type: "TEXT_MESSAGE_CONTENT", messageId: "m2", delta: "child text", subagentRunId: "child-1" },
        { type: "SUBAGENT_FINISHED", subagentRunId: "child-1" },
      ];
      yield* Queue.offerAll(feed, childEvents);

      const events = yield* Stream.runCollect(mergeSubagentFeed(Stream.fromIterable(harnessEvents), feed));

      assert.sameDeepMembers(events, [...harnessEvents, ...childEvents]);
      assert.strictEqual(events.at(-1)?.type, "RUN_FINISHED");
    }),
  );

  it.effect("passes the harness events through unchanged when no child ran", () =>
    Effect.gen(function* () {
      const feed = yield* makeSubagentFeed;

      const events = yield* Stream.runCollect(mergeSubagentFeed(Stream.fromIterable(harnessEvents), feed));

      assert.deepStrictEqual(events, harnessEvents);
    }),
  );
});
