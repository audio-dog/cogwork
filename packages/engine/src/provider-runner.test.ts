import { agUiTextDelta, RunPlan } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import { toolDefinition } from "@tanstack/ai";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  defaultModelAdapterFactory,
  type ModelAdapterFactory,
  parseModelRef,
  providerModelRefs,
} from "./provider-adapter";
import {
  defaultLoopBudget,
  defaultRunBudget,
  providerInstructionContext,
  providerRunner,
  type RunChat,
  type RunChatOptions,
} from "./provider-runner";
import {
  harnessName,
  providerRunnerLayer,
  request,
  SECRET,
  sampleLayer,
  scratchCheckout,
  scriptedChunks,
  scriptedRunChat,
  sessionId,
  sessionLayer,
  toAsyncIterable,
} from "./provider-runner-fixtures";
import { isPolicyDenied } from "./tools";

describe("providerRunner", { timeout: 30_000 }, () => {
  it("projects Operating Instructions resources into provider context", () => {
    assert.deepStrictEqual(
      providerInstructionContext(request({}).plan).map(({ content }) => content),
      [sampleLayer.content, "guide"],
    );
  });

  it("declares the owned-transcript session kind", () => {
    assert.strictEqual(providerRunner({ name: harnessName }).sessionKind, "owned-transcript");
  });

  it("serves every managed provider model", () => {
    assert.deepStrictEqual(
      providerRunner({ name: harnessName }).catalog.models.map(({ value }) => value),
      providerModelRefs,
    );
  });

  it.live(
    "bridges chat output, folds the resumed thread, hands the redacted key to the adapter, and never leaks it",
    () =>
      Effect.gen(function* () {
        const checkoutPath = yield* scratchCheckout();
        const adapterCalls: Array<{ provider: string; model: string; key: Redacted.Redacted<string> }> = [];
        const capturedOptions: Array<RunChatOptions> = [];

        const makeAdapter: ModelAdapterFactory = (resolved, key) => {
          adapterCalls.push({ provider: resolved.provider, model: resolved.model, key });
          return defaultModelAdapterFactory(resolved, key);
        };
        const runChat: RunChat = (options) => {
          capturedOptions.push(options);
          return toAsyncIterable(scriptedChunks);
        };
        const runner = providerRunner({ name: harnessName, makeAdapter, runChat });

        const events = yield* Stream.runCollect(
          runner.run(request({ checkoutPath, session: sessionId })),
        ).pipe(
          Effect.provide(
            Layer.mergeAll(
              providerRunnerLayer(),
              sessionLayer([{ role: "assistant", content: "earlier turn" }]),
            ),
          ),
        );

        const serialized = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(events);
        assert.include(serialized, "hello world");
        assert.notInclude(serialized, SECRET);
        assert.isTrue(events.some((event) => agUiTextDelta(event) === "hello world"));

        assert.lengthOf(adapterCalls, 1);
        assert.strictEqual(adapterCalls[0]?.provider, "openai");
        assert.strictEqual(adapterCalls[0]?.model, "gpt-4o");
        assert.strictEqual(adapterCalls[0] ? Redacted.value(adapterCalls[0].key) : null, SECRET);

        const options = capturedOptions[0];
        if (!options) return assert.fail("runChat was never invoked");
        assert.strictEqual(options.messages.length, 3);
        assert.deepStrictEqual(options.messages[0], { role: "assistant", content: "earlier turn" });
        assert.strictEqual(options.messages[1]?.role, "user");
        assert.deepStrictEqual(options.messages[2], { role: "user", content: "do the thing" });
        assert.include(String(options.messages[1]?.content), "Ship the requested provider change.");
        assert.include(String(options.messages[1]?.content), "Keep the adapter contract stable.");
        assert.lengthOf([...options.tools], 7);
        assert.isTrue(options.middleware.some((middleware) => middleware.name === "cogwork-context"));
        assert.isTrue(options.middleware.some((middleware) => middleware.name === "chat-persistence"));
        assert.strictEqual(options.runId, "run-provider-test");
        assert.strictEqual(options.threadId, sessionId);
      }),
    30000,
  );

  it.live("keys a fresh chat thread by its Session", () =>
    Effect.gen(function* () {
      const checkoutPath = yield* scratchCheckout();
      const capturedOptions: Array<RunChatOptions> = [];
      const runChat: RunChat = (options) => {
        capturedOptions.push(options);
        return toAsyncIterable(scriptedChunks);
      };
      const runner = providerRunner({ name: harnessName, runChat });

      yield* Stream.runDrain(runner.run(request({ checkoutPath }))).pipe(
        Effect.provide(providerRunnerLayer()),
      );

      assert.strictEqual(capturedOptions[0]?.threadId, sessionId);
    }),
  );

  it.live("renders an engine-owned issue search tool named by the Run Plan", () =>
    Effect.gen(function* () {
      const capturedOptions: Array<RunChatOptions> = [];
      const runChat: RunChat = (options) => {
        capturedOptions.push(options);
        return toAsyncIterable(scriptedChunks);
      };
      const runner = providerRunner({ name: harnessName, runChat });
      const base = request({ checkoutPath: null });
      const issueSearch = toolDefinition({
        name: "issue-search",
        description: "Search issues",
      }).server(() => Promise.resolve({ matches: [] }));
      const plan = RunPlan.make({ ...base.plan, tools: [...base.plan.tools, "issue-search"] });

      yield* Stream.runDrain(runner.run({ ...base, plan, engineTools: [issueSearch] })).pipe(
        Effect.provide(providerRunnerLayer()),
      );

      assert.isTrue(capturedOptions[0]?.tools.some(({ name }) => name === "issue-search"));
    }),
  );

  it.live("supplies the Run Plan's Skills to the chat through the skills middleware", () =>
    Effect.gen(function* () {
      const capturedOptions: Array<RunChatOptions> = [];
      const runChat: RunChat = (options) => {
        capturedOptions.push(options);
        return toAsyncIterable(scriptedChunks);
      };
      const runner = providerRunner({ name: harnessName, runChat });
      const base = request({ checkoutPath: null });
      const skills = [{ identity: "local:repo/skill/release", name: "release", source: "/skills/SKILL.md" }];

      yield* Stream.runDrain(runner.run({ ...base, plan: RunPlan.make({ ...base.plan, skills }) })).pipe(
        Effect.provide(providerRunnerLayer()),
      );
      yield* Stream.runDrain(runner.run(base)).pipe(Effect.provide(providerRunnerLayer()));

      assert.deepStrictEqual(
        capturedOptions.map(({ middleware }) => middleware.some(({ name }) => name === "skills")),
        [true, false],
      );
    }),
  );

  it.live("runs without a Workspace in an empty scratch directory and removes it after the Run", () =>
    Effect.gen(function* () {
      const roots: Array<string> = [];
      const runChat = scriptedRunChat((options) => {
        const bash = options.tools.find((tool) => tool.name === "bash")?.execute;
        if (!bash) return Promise.reject(new Error("bash tool was not provided"));
        return Promise.resolve(bash({ command: "pwd\nfind . -mindepth 1 -maxdepth 1 -print" })).then(
          (result) => {
            if (isPolicyDenied(result)) throw new Error(result.reason);
            const [root, ...entries] = result.stdout.trim().split("\n");
            if (!root) throw new Error("scratch directory path was empty");
            roots.push(root);
            assert.deepStrictEqual(entries, []);
          },
        );
      });
      const runner = providerRunner({ name: harnessName, runChat });

      yield* Stream.runDrain(runner.run(request({ checkoutPath: null })));

      const root = roots[0];
      if (!root) return assert.fail("scratch directory was not opened");
      const fs = yield* FileSystem.FileSystem;
      assert.isFalse(yield* fs.exists(root));
    }).pipe(Effect.provide(providerRunnerLayer())),
  );

  it.live("uses the Workspace checkout for a read-only Run and denies writes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const checkoutPath = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-provider-read-only-" });
      yield* fs.writeFileString(`${checkoutPath}/seed.txt`, "workspace checkout");
      const runChat = scriptedRunChat((options) => {
        const read = options.tools.find((tool) => tool.name === "read")?.execute;
        const write = options.tools.find((tool) => tool.name === "write")?.execute;
        if (!read || !write) return Promise.reject(new Error("owned file tools were not provided"));
        return Promise.all([
          read({ path: "seed.txt" }),
          write({ path: "changed.txt", content: "blocked" }),
        ]).then(([readResult, writeResult]) => {
          assert.deepStrictEqual(readResult, {
            path: "seed.txt",
            content: "workspace checkout",
          });
          assert.isTrue(isPolicyDenied(writeResult));
        });
      });
      const runner = providerRunner({ name: harnessName, runChat });

      yield* Stream.runDrain(runner.run(request({ operation: "triage", checkoutPath })));

      assert.isFalse(yield* fs.exists(`${checkoutPath}/changed.txt`));
    }).pipe(Effect.provide(providerRunnerLayer())),
  );

  it.live("uses the prepared checkout for a full Run", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const checkoutPath = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-provider-worktree-" });
      yield* fs.writeFileString(`${checkoutPath}/branch.txt`, "branch worktree");
      const runChat = scriptedRunChat((options) => {
        const read = options.tools.find((tool) => tool.name === "read")?.execute;
        if (!read) return Promise.reject(new Error("read tool was not provided"));
        return Promise.resolve(read({ path: "branch.txt" })).then((result) => {
          assert.deepStrictEqual(result, {
            path: "branch.txt",
            content: "branch worktree",
          });
        });
      });
      const runner = providerRunner({ name: harnessName, runChat });

      yield* Stream.runDrain(runner.run(request({ checkoutPath })));
    }).pipe(Effect.provide(providerRunnerLayer())),
  );
});

describe("parseModelRef", () => {
  it("splits a provider/model reference", () => {
    assert.deepStrictEqual(parseModelRef("openai/gpt-4o"), { provider: "openai", model: "gpt-4o" });
  });

  it("returns null for a bare model with no provider prefix", () => {
    assert.isNull(parseModelRef("gpt-4o"));
  });

  it("returns null for an unwired provider prefix", () => {
    assert.isNull(parseModelRef("openrouter/some-model"));
  });
});

describe("defaultLoopBudget", () => {
  it("gives read-only profiles fewer turns than full profiles", () => {
    assert.isBelow(defaultLoopBudget("read-only"), defaultLoopBudget("full"));
  });
});

describe("defaultRunBudget", () => {
  it("gives read-only profiles less wall-clock time than full profiles", () => {
    assert.strictEqual(defaultRunBudget("read-only"), "15 minutes");
    assert.strictEqual(defaultRunBudget("full"), "2 hours");
  });
});
