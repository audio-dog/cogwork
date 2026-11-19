import { agUiUsage, type ModelLevel, RunPlan, RunPlanSubagent } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import { EventType, type StreamChunk, type TextOptions, toolDefinition } from "@tanstack/ai";
import { getWorkspaceProjection } from "@tanstack/ai-sandbox";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";
import { externalHarnessRunner } from "./external-harness-runtime";
import {
  ControlledAdapter,
  type ControlledOptions,
  ControlledProbe,
  descriptor,
  freshSession,
  harnessRunnerLayer,
  makeHarness,
  request,
  resumedSession,
  runtimeCapabilities,
  terminalEvents,
  toAsyncIterable,
} from "./external-harness-runtime-fixtures";
import { hasToolResults, subagentCallTurn, textTurn } from "./testing/scripted-adapter";

describe("external Harness runtime", { timeout: 30_000 }, () => {
  it.layer(harnessRunnerLayer)((it) => {
    it("owns the common external Harness declaration", () => {
      const runner = externalHarnessRunner(descriptor([], new ControlledProbe()), {
        authentication: () => Effect.succeed({ mode: "host", secrets: {} }),
      });

      assert.strictEqual(runner.sessionKind, "opaque-handle");
      assert.deepStrictEqual(runner.projectedMembers, [
        "Harness Adapter",
        "Instructions",
        "Messages",
        "MCP",
        "Middleware",
        "Sandbox",
        "Structured Output",
        "Persistence",
        "Connections",
      ]);
      assert.deepStrictEqual(runner.planMiddleware, ["sandbox"]);
      const toolRunner = externalHarnessRunner(
        { ...descriptor([], new ControlledProbe()), declaredMembers: ["Tools"] },
        { authentication: () => Effect.succeed({ mode: "host", secrets: {} }) },
      );
      assert.include(toolRunner.projectedMembers, "Tools");
    });

    it.effect(
      "projects mandatory instructions through one Harness Workspace and keeps work context user-authored",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const checkout = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-workspace-projection-" });
          const probe = new ControlledProbe();
          const base = descriptor(terminalEvents, probe);
          const harness = makeHarness({ ...base, transport: {} });
          const plan = RunPlan.make({
            ...request,
            sandbox: { ...request.sandbox, workspace: checkout },
          });

          yield* harness
            .run({ plan, session: freshSession, mcpCredentials: new Map() })
            .pipe(Stream.runDrain);

          const chatOptions = probe.chatOptions[0];
          if (!chatOptions) return assert.fail("adapter received no chat options");
          const projection = getWorkspaceProjection(runtimeCapabilities(chatOptions));
          const instructions = yield* fs.readFileString(`${checkout}/AGENTS.md`);
          assert.include(instructions, "Follow repo rules.");
          assert.include(instructions, "Mandatory Operating Instructions: /instructions/implement-agent");
          assert.strictEqual(projection.root, checkout);
          const messages = probe.chatOptions[0]?.messages ?? [];
          assert.strictEqual(messages.length, 2);
          assert.strictEqual(messages[0]?.role, "user");
          assert.include(messages[0]?.content ?? "", "Ship the external Harness change.");
          assert.include(messages[0]?.content ?? "", "Keep this instruction in the admitted snapshot.");
          assert.deepStrictEqual(messages[1], { role: "user", content: "Implement #147." });
          assert.deepStrictEqual(probe.chatOptions[0]?.systemPrompts, []);
        }),
    );

    it.effect("renders only the Run Plan's engine tools, and only for a descriptor that declares Tools", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const checkout = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-engine-tool-" });
        const pullRequestTool = toolDefinition({
          name: "pull-request",
          description: "Read a pull request",
        }).server(() => Promise.resolve({}));
        const hiddenTool = toolDefinition({
          name: "hidden-tool",
          description: "Must stay hidden",
        }).server(() => Promise.resolve({}));
        const plan = RunPlan.make({
          ...request,
          tools: ["pull-request"],
          sandbox: { ...request.sandbox, workspace: checkout },
        });
        const chatTools = (declaredMembers: ReadonlyArray<"Tools">) => {
          const probe = new ControlledProbe();
          return makeHarness({ ...descriptor(terminalEvents, probe), declaredMembers })
            .run({
              plan,
              session: freshSession,
              mcpCredentials: new Map(),
              engineTools: [pullRequestTool, hiddenTool],
            })
            .pipe(
              Stream.runDrain,
              Effect.map(() => probe.chatOptions[0]?.tools?.map(({ name }) => name)),
            );
        };

        assert.deepStrictEqual(yield* chatTools(["Tools"]), ["pull-request"]);
        assert.deepStrictEqual(yield* chatTools([]), []);
      }),
    );

    it.effect(
      "starts each admitted Subagent as a child on the level's model, adds its usage, and writes no file",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const checkout = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-subagent-checkout-" });
          const subagent = (subagentName: string, modelLevel: ModelLevel) =>
            RunPlanSubagent.cases.Available.make({
              identity: `local:repo/${subagentName}`,
              name: subagentName,
              source: `.agents/agents/${subagentName}.md`,
              description: `The ${subagentName} Subagent`,
              tools: [],
              modelLevel,
              prompt: `You are the ${subagentName}.`,
            });
          const unavailable = RunPlanSubagent.cases.Unavailable.make({
            identity: "local:repo/broken",
            name: "broken",
            source: ".agents/agents/broken.md",
            reason: "no frontmatter",
          });
          const parentTurn = (options: TextOptions<ControlledOptions>): ReadonlyArray<StreamChunk> =>
            hasToolResults(options)
              ? [
                  ...terminalEvents.slice(0, -1),
                  {
                    type: EventType.RUN_FINISHED,
                    threadId: "session-148",
                    runId: request.id,
                    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
                  },
                ]
              : subagentCallTurn(
                  [
                    { id: "call-reviewer", agent: "reviewer", task: "Review the diff." },
                    { id: "call-scout", agent: "scout", task: "Find the seam." },
                  ],
                  1,
                );
          const probe = new ControlledProbe();
          const { estimateUsage: _estimate, ...base } = descriptor([], probe);
          const harness = makeHarness({
            ...base,
            declaredMembers: ["Subagents"],
            modelLevels: { light: "controlled-light" },
            makeAdapter: (resolved) => {
              probe.resolved.push(resolved);
              const turn =
                resolved.request.subagents.length > 0 ? parentTurn : () => textTurn("child done", 5);
              return new ControlledAdapter((options) => toAsyncIterable(turn(options)), probe);
            },
          });

          const events = yield* harness
            .run({
              plan: RunPlan.make({
                ...request,
                subagents: [subagent("reviewer", "light"), subagent("scout", "standard"), unavailable],
                sandbox: { ...request.sandbox, workspace: checkout },
              }),
              session: resumedSession,
              mcpCredentials: new Map(),
            })
            .pipe(Stream.runCollect);

          const children = probe.resolved.slice(1).map(({ request: child }) => child);
          assert.sameMembers(
            children.map(({ selection }) => selection.model),
            ["controlled-light", "controlled"],
          );
          assert.isTrue(
            children.every(({ identity, tools }) => identity.resumeHandle === null && tools.length === 0),
          );
          assert.deepStrictEqual(
            probe.chatOptions[0]?.tools?.map(({ name }) => name),
            ["reviewer", "scout"],
          );
          const childCall = (prompt: string) =>
            probe.chatOptions.find(({ systemPrompts }) => systemPrompts?.includes(prompt));
          assert.deepStrictEqual(childCall("You are the reviewer.")?.messages.at(-1), {
            role: "user",
            content: "Review the diff.",
          });
          assert.deepStrictEqual(childCall("You are the scout.")?.messages.at(-1), {
            role: "user",
            content: "Find the seam.",
          });
          const finished = events.findLast((event) => event.type === EventType.RUN_FINISHED);
          assert.strictEqual(finished ? agUiUsage(finished)?.totalTokens : null, 22);
          assert.deepStrictEqual(yield* fs.readDirectory(checkout), []);
        }),
    );

    it.effect("supplies Run Plan Skills through chat() only for a descriptor that declares Skills", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const checkout = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-skills-checkout-" });
        const skillRoot = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-skills-source-" });
        const skillFile = `${skillRoot}/release.md`;
        yield* fs.writeFileString(
          skillFile,
          "---\nname: release-notes\ndescription: Cut a release.\n---\n# Release\nTag, then publish.",
        );
        yield* fs.writeFileString(`${skillRoot}/broken.md`, "# No frontmatter");
        yield* fs.writeFileString(
          `${skillRoot}/oversized.md`,
          `---\nname: oversized\ndescription: Oversized ${"x".repeat(16_000)}\n---\nBody.`,
        );
        const plan = RunPlan.make({
          ...request,
          skills: [
            { identity: "local:repo/skill/release", name: "release", source: skillFile },
            { identity: "local:repo/skill/broken", name: "broken", source: `${skillRoot}/broken.md` },
            { identity: "local:repo/skill/missing", name: "missing", source: `${skillRoot}/missing.md` },
            {
              identity: "local:repo/skill/oversized",
              name: "oversized",
              source: `${skillRoot}/oversized.md`,
            },
          ],
          sandbox: { ...request.sandbox, workspace: checkout },
        });
        const loaded: Array<string> = [];
        const runCatalog = (declaredMembers: ReadonlyArray<"Tools" | "Skills">) => {
          const probe = new ControlledProbe();
          probe.inspect = (options) => {
            const loadSkill = options.tools?.find(({ name }) => name === "load_skill")?.execute;
            if (!loadSkill) return Promise.resolve();
            const load = (name: string) =>
              Promise.resolve(loadSkill({ name })).then(
                (result) => {
                  loaded.push(Predicate.hasProperty(result, "content") ? String(result.content) : "");
                },
                (refusal) => {
                  loaded.push(String(refusal));
                },
              );
            return load("release").then(() => load("release-notes"));
          };
          return makeHarness({ ...descriptor(terminalEvents, probe), declaredMembers })
            .run({ plan, session: freshSession, mcpCredentials: new Map() })
            .pipe(
              Stream.runDrain,
              Effect.map(() =>
                (probe.chatOptions[0]?.systemPrompts ?? [])
                  .map((prompt) => (typeof prompt === "string" ? prompt : prompt.content))
                  .join("\n"),
              ),
            );
        };

        const catalog = yield* runCatalog(["Tools", "Skills"]);
        const withheld = yield* runCatalog(["Tools"]);

        assert.include(catalog, "Cut a release.");
        assert.notInclude(catalog, "release-notes");
        assert.notInclude(catalog, "broken");
        assert.notInclude(catalog, "missing");
        assert.notInclude(catalog, "Oversized");
        assert.lengthOf(loaded, 2);
        assert.include(loaded[0], "Tag, then publish.");
        assert.include(loaded[1], "Skill release-notes is not in the Run Plan");
        assert.notInclude(withheld, "Cut a release.");
        assert.deepStrictEqual(yield* fs.readDirectory(checkout), []);
      }),
    );
  });
});
