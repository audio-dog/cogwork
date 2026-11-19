import {
  type AgUiEvent,
  agUiIsFileDiffUnavailableEvent,
  agUiIsSubagentEvent,
  agUiTextDelta,
  agUiUsage,
  type ModelLevel,
  RunPlanSubagent,
} from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import type { StreamChunk, TextOptions } from "@tanstack/ai";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import type { ModelAdapterFactory } from "./provider-adapter";
import { mergeProviderFileDiffs, providerRunner, type RunChat, type RunChatOptions } from "./provider-runner";
import {
  credentialLayer,
  harnessName,
  keyProvider,
  missingKeyProvider,
  nativeStructuredAdapter,
  providerRunnerLayer,
  request,
  scratchCheckout,
  scriptedChunks,
  toAsyncIterable,
} from "./provider-runner-fixtures";
import { hasToolResults, scriptedAdapter, subagentCallTurn, textTurn } from "./testing/scripted-adapter";

describe("providerRunner stream", { timeout: 30_000 }, () => {
  it.live("refuses to open a chat without a Session", () =>
    Effect.gen(function* () {
      const checkoutPath = yield* scratchCheckout();
      const runner = providerRunner({ name: harnessName, runChat: () => toAsyncIterable(scriptedChunks) });

      const error = yield* Effect.flip(
        Stream.runDrain(runner.run(request({ checkoutPath, session: null }))).pipe(
          Effect.provide(providerRunnerLayer()),
        ),
      );

      assert.strictEqual(error.reason, "launch");
      assert.include(error.message, "Session");
    }),
  );

  it.live("aborts the chat request when the provider stream is interrupted", () =>
    Effect.gen(function* () {
      const checkoutPath = yield* scratchCheckout();
      const captured = Promise.withResolvers<RunChatOptions>();
      const runChat: RunChat = (options) => {
        captured.resolve(options);
        return {
          [Symbol.asyncIterator]: () => ({
            next: () => Promise.withResolvers<IteratorResult<StreamChunk>>().promise,
          }),
        };
      };
      const runner = providerRunner({ name: harnessName, runChat });
      const fiber = yield* Stream.runDrain(runner.run(request({ checkoutPath }))).pipe(
        Effect.provide(providerRunnerLayer()),
        Effect.forkChild,
      );
      const chatOptions = yield* Effect.promise(() => captured.promise);

      yield* Fiber.interrupt(fiber);

      assert.isTrue(chatOptions.abortController.signal.aborted);
    }),
  );

  it.effect("keeps the provider Run alive and reports a dead diff feed", () =>
    Effect.gen(function* () {
      const harnessEvents = Stream.make(
        { type: "RUN_STARTED" } satisfies AgUiEvent,
        { type: "RUN_FINISHED", finishReason: "stop" } satisfies AgUiEvent,
      );
      const merged = yield* mergeProviderFileDiffs(harnessEvents, () =>
        Stream.fail(new Error("raw provider watcher failure")),
      );
      const events = yield* Stream.runCollect(merged);

      assert.isTrue(events.some(agUiIsFileDiffUnavailableEvent));
      assert.strictEqual(events.at(-1)?.type, "RUN_FINISHED");
    }),
  );

  it.effect("releases the provider terminal event when the diff feed does not drain", () =>
    Effect.gen(function* () {
      const harnessEvents = Stream.make(
        { type: "RUN_STARTED" } satisfies AgUiEvent,
        { type: "RUN_FINISHED", finishReason: "stop" } satisfies AgUiEvent,
      );
      const merged = yield* mergeProviderFileDiffs(harnessEvents, () => Stream.never);
      const collected = yield* Stream.runCollect(merged).pipe(Effect.forkChild({ startImmediately: true }));

      yield* TestClock.adjust("10 seconds");
      const events = yield* Fiber.join(collected);

      assert.isTrue(events.some(agUiIsFileDiffUnavailableEvent));
      assert.strictEqual(events.at(-1)?.type, "RUN_FINISHED");
    }),
  );

  it.live("runs owned tools with the caller's HTTP client", () =>
    Effect.gen(function* () {
      const checkoutPath = yield* scratchCheckout();
      const httpClient = HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response("from caller", { status: 200 }))),
      );
      const runChat: RunChat = (options) => {
        const execute = options.tools.find((tool) => tool.name === "webfetch")?.execute;
        if (!execute) throw new Error("webfetch tool was not provided");
        const iterator = Promise.resolve(execute({ url: "https://example.invalid" })).then((result) => {
          assert.deepStrictEqual(result, {
            url: "https://example.invalid",
            status: 200,
            content: "from caller",
          });
          return toAsyncIterable(scriptedChunks)[Symbol.asyncIterator]();
        });
        return {
          [Symbol.asyncIterator]: () => ({ next: () => iterator.then((current) => current.next()) }),
        };
      };
      const runner = providerRunner({ name: harnessName, runChat });

      yield* Stream.runDrain(runner.run(request({ checkoutPath }))).pipe(
        Effect.provide(
          providerRunnerLayer(credentialLayer(keyProvider), Layer.succeed(HttpClient.HttpClient, httpClient)),
        ),
        Effect.timeout("5 seconds"),
      );
    }),
  );

  it.live("streams one structured triage result through TanStack's provider path", () =>
    Effect.gen(function* () {
      const checkoutPath = yield* scratchCheckout();
      const runner = providerRunner({
        name: harnessName,
        makeAdapter: () => nativeStructuredAdapter,
      });

      const events = yield* Stream.runCollect(
        runner.run(request({ operation: "triage", checkoutPath })),
      ).pipe(Effect.provide(providerRunnerLayer()));

      assert.strictEqual(
        events.filter((event) => event.type === "CUSTOM" && event.name === "structured-output.complete")
          .length,
        1,
      );
      assert.isTrue(events.some((event) => event.type === "TEXT_MESSAGE_CONTENT"));
      assert.strictEqual(events.at(-1)?.type, "RUN_FINISHED");
    }),
  );

  it.live("runs a light Subagent on the provider's light model and a standard one on the parent model", () =>
    Effect.gen(function* () {
      const checkoutPath = yield* scratchCheckout();
      const subagent = (name: string, modelLevel: ModelLevel) =>
        RunPlanSubagent.cases.Available.make({
          identity: `local:repo/${name}`,
          name,
          source: `.agents/agents/${name}.md`,
          description: `The ${name} Subagent`,
          tools: [],
          modelLevel,
          prompt: `You are the ${name}.`,
        });
      const lightCalls: Array<TextOptions> = [];
      const parentCalls: Array<TextOptions> = [];
      const parentTurn = (options: TextOptions) => {
        if (options.systemPrompts?.includes("You are the scout.")) return textTurn("scout done", 5);
        if (hasToolResults(options)) return textTurn('{"outcome":"done"}', 1);
        return subagentCallTurn(
          [
            { id: "call-reviewer", agent: "reviewer", task: "Review the diff." },
            { id: "call-scout", agent: "scout", task: "Find the seam." },
          ],
          1,
        );
      };
      const makeAdapter: ModelAdapterFactory = ({ model }) =>
        model === "gpt-6-luna"
          ? scriptedAdapter(model, () => textTurn("review done", 5), lightCalls)
          : scriptedAdapter(model, parentTurn, parentCalls);
      const runner = providerRunner({ name: harnessName, makeAdapter });

      const events = yield* Stream.runCollect(
        runner.run(
          request({
            checkoutPath,
            subagents: [subagent("reviewer", "light"), subagent("scout", "standard")],
          }),
        ),
      ).pipe(Effect.provide(providerRunnerLayer()));

      assert.deepStrictEqual(
        lightCalls.map(({ messages }) => messages.at(-1)?.content),
        ["Review the diff."],
      );
      assert.isTrue(parentCalls.some((options) => options.messages.at(-1)?.content === "Find the seam."));
      const reviewText = events.filter((event) => agUiTextDelta(event) === "review done");
      assert.isTrue(reviewText.length > 0 && reviewText.every(agUiIsSubagentEvent));
      const finished = events.findLast((event) => event.type === "RUN_FINISHED");
      assert.strictEqual(finished ? agUiUsage(finished)?.totalTokens : null, 22);
    }),
  );

  it.effect("fails with a launch error when the model has no wired provider", () =>
    Effect.gen(function* () {
      const runner = providerRunner({
        name: harnessName,
        runChat: () => toAsyncIterable(scriptedChunks),
      });
      const error = yield* Effect.flip(
        Stream.runDrain(runner.run(request({ model: "unknown-provider/whatever" }))).pipe(
          Effect.provide(providerRunnerLayer()),
        ),
      );
      assert.strictEqual(error._tag, "HarnessError");
      assert.strictEqual(error.reason, "launch");
    }),
  );

  it.effect("fails with a launch error when no api key is configured", () =>
    Effect.gen(function* () {
      const runner = providerRunner({
        name: harnessName,
        runChat: () => toAsyncIterable(scriptedChunks),
      });
      const error = yield* Effect.flip(
        Stream.runDrain(runner.run(request({}))).pipe(
          Effect.provide(providerRunnerLayer(credentialLayer(missingKeyProvider))),
        ),
      );
      assert.strictEqual(error._tag, "HarnessError");
      assert.strictEqual(error.reason, "launch");
    }),
  );
});
