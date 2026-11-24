import { AgUiEvent, agUiIsStructuredOutputComplete, agUiUsage, RunPlan } from "@cogwork/contracts";
import { Harness, SessionStore } from "@cogwork/engine";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { assert, describe, it, layer } from "@effect/vitest";
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";

import { cursorModelOptions, cursorRunner, estimatedUsage } from "./harness";
import {
  cursorEnvironmentProbe,
  cursorName,
  cursorNetworkEnvironmentProbe,
  cursorWindowsEnvironmentProbe,
  decodeObservation,
  decodePermissionOutcome,
  fakeCursorAgent,
  freshSessionId,
  harnessRunnerLayer,
  request,
  resumedSessionId,
  sessionStore,
  withCursorEnvironment,
} from "./harness-fixtures";

layer(harnessRunnerLayer)("cursorRunner", (it) => {
  it("declares programmatic resume, Tools and Skills, and Cursor's lower runtime fidelity", () => {
    const runner = cursorRunner({ name: cursorName });
    assert.strictEqual(runner.sessionKind, "opaque-handle");
    assert.includeMembers([...runner.projectedMembers], ["Tools", "Skills"]);
    assert.deepStrictEqual(runner.capabilities.authenticationModes, ["host"]);
    assert.isFalse(runner.capabilities.session.humanAttach);
    assert.strictEqual(runner.capabilities.structuredOutput, "prompt-and-parse");
    assert.strictEqual(runner.capabilities.policyFidelity, "none");
    assert.strictEqual(runner.capabilities.fileEventFidelity, "absent");
    assert.isFalse(runner.capabilities.journal);
    assert.isFalse(runner.capabilities.takeover);
    assert.isTrue(runner.execution.nonInteractive);
    assert.isFalse(runner.execution.worktreeConfined);
    assert.deepStrictEqual(runner.execution.profiles, ["full"]);
  });

  it.effect(
    "accepts Full and rejects Read only before launching Cursor",
    () =>
      Effect.gen(function* () {
        const harness = Harness.make([
          cursorRunner({ name: cursorName, agentBin: `node ${fakeCursorAgent}` }),
        ]);
        const readOnly = yield* harness.preflight(cursorName, "read-only", "auto").pipe(Effect.flip);

        assert.strictEqual(readOnly.reason, "policy");
        assert.include(readOnly.message, "read-only operation posture");
        yield* harness.preflight(cursorName, "full", "auto");
      }),
    30_000,
  );

  it.effect(
    "uses host login and projects instructions without touching repo instruction files",
    () =>
      withCursorEnvironment(
        Effect.gen(function* () {
          const checkout = yield* Effect.acquireRelease(
            Effect.promise(() => localProcessSandbox({}).create({})),
            (sandbox) => Effect.promise(() => sandbox.destroy()),
          );
          yield* Effect.promise(() => checkout.fs.write("AGENTS.md", "existing repo agents\n"));
          yield* Effect.promise(() => checkout.fs.write("CLAUDE.md", "existing repo claude\n"));
          const base = request(checkout.id);
          const projectedRequest = {
            ...base,
            plan: new RunPlan({
              ...base.plan,
              harness: {
                ...base.plan.harness,
                model: "gpt-5.6-sol",
                options: { effort: "high" },
              },
              instructions: [{ kind: "repo", source: "repo", content: "Mandatory repository context." }],
              operatingInstructions: {
                name: "triage-agent",
                path: "/operating-instructions/triage-agent",
                resources: [],
              },
              mcp: [
                {
                  identity: "local:user/mcp-server/linear",
                  name: "linear",
                  projectedName: "linear",
                  endpoint: "https://mcp.example.test/readonly",
                  authenticated: true,
                  unavailableReason: null,
                },
              ],
              structuredOutput: null,
            }),
            mcpCredentials: new Map([["local:user/mcp-server/linear", Redacted.make("cursor-mcp-secret")]]),
          } satisfies Harness.HarnessRequest;
          const runner = cursorRunner({
            name: cursorName,
            agentBin: `node ${fakeCursorAgent} --observe`,
          });

          const events = yield* Stream.runCollect(runner.run(projectedRequest));
          const output = Array.from(events)
            .filter(AgUiEvent.guards.TEXT_MESSAGE_CONTENT)
            .map(({ delta }) => delta ?? "")
            .join("");
          const observation = decodeObservation(output);

          assert.include(observation.prompt, "Mandatory repository context.");
          assert.include(observation.prompt, "/operating-instructions/triage-agent");
          assert.strictEqual(observation.model, "gpt-5.6-sol-high");
          assert.deepStrictEqual(observation.mcp, [
            {
              name: "linear",
              url: "https://mcp.example.test/readonly",
              authenticated: true,
            },
          ]);
          assert.strictEqual(observation.cursorConfigDir, cursorEnvironmentProbe.CURSOR_CONFIG_DIR);
          assert.deepStrictEqual(observation.windowsEnvironment, cursorWindowsEnvironmentProbe);
          assert.deepStrictEqual(observation.networkEnvironment, cursorNetworkEnvironmentProbe);
          assert.isFalse(observation.hasCursorApiKey);
          assert.notInclude(output, "cursor-mcp-secret");
          assert.strictEqual(
            yield* Effect.promise(() => checkout.fs.read("AGENTS.md")),
            "existing repo agents\n",
          );
          assert.strictEqual(
            yield* Effect.promise(() => checkout.fs.read("CLAUDE.md")),
            "existing repo claude\n",
          );
        }),
      ),
    30_000,
  );

  it.effect(
    "refuses a stale model at dispatch",
    () =>
      Effect.gen(function* () {
        const checkout = yield* Effect.acquireRelease(
          Effect.promise(() => localProcessSandbox({}).create({})),
          (sandbox) => Effect.promise(() => sandbox.destroy()),
        );
        const base = request(checkout.id);
        const staleRequest = {
          ...base,
          plan: new RunPlan({
            ...base.plan,
            harness: {
              ...base.plan.harness,
              model: "retired-cursor-model",
            },
          }),
        } satisfies Harness.HarnessRequest;
        const runner = cursorRunner({ name: cursorName, agentBin: `node ${fakeCursorAgent}` });

        const failure = yield* Stream.runDrain(runner.run(staleRequest)).pipe(Effect.flip);

        assert.strictEqual(failure.reason, "stale-selection");
        assert.include(failure.message, "retired-cursor-model");
      }),
    30_000,
  );

  it.effect(
    "streams a fresh ACP session, parsed structured result, and estimated terminal usage",
    () =>
      Effect.gen(function* () {
        const checkout = yield* Effect.acquireRelease(
          Effect.promise(() => localProcessSandbox({}).create({})),
          (sandbox) => Effect.promise(() => sandbox.destroy()),
        );
        const runner = cursorRunner({ name: cursorName, agentBin: `node ${fakeCursorAgent}` });

        const events = yield* Stream.runCollect(runner.run(request(checkout.id)));
        const session = Array.from(events).find(
          (event) => AgUiEvent.guards.CUSTOM(event) && event.name === "cursor.session-id",
        );
        const structured = Array.from(events).find(agUiIsStructuredOutputComplete);
        const finished = events.at(-1);

        assert.deepStrictEqual(session?.value, { sessionId: "fake-cursor-session" });
        assert.deepNestedInclude(
          Array.from(events).find((event) => event.type === "RUN_STARTED"),
          { runId: "run-cursor-test", threadId: freshSessionId },
        );
        assert.deepStrictEqual(structured?.value.object, {
          _tag: "triage",
          role: "ready-for-agent",
          proposal: "Verified and ready.",
        });
        assert.strictEqual(finished?.type, "RUN_FINISHED");
        assert.isDefined(finished);
        assert.isTrue(agUiUsage(finished)?.estimated);
      }),
    30_000,
  );

  it.effect(
    "projects the persisted opaque handle through modelOptions.sessionId",
    () =>
      Effect.gen(function* () {
        const checkout = yield* Effect.acquireRelease(
          Effect.promise(() => localProcessSandbox({}).create({})),
          (sandbox) => Effect.promise(() => sandbox.destroy()),
        );
        const resumeHandle = "persisted-cursor-session";
        const resumedRequest = {
          ...request(checkout.id),
          session: resumedSessionId,
        } satisfies Harness.HarnessRequest;
        const resumedStore = { ...sessionStore, resumeHandle: () => Effect.succeed(resumeHandle) };
        const runner = cursorRunner({ name: cursorName, agentBin: `node ${fakeCursorAgent}` });

        const events = yield* Stream.runCollect(
          runner.run(resumedRequest).pipe(Stream.provideService(SessionStore.SessionStore, resumedStore)),
        );
        const session = Array.from(events).find(
          (event) => AgUiEvent.guards.CUSTOM(event) && event.name === "cursor.session-id",
        );

        assert.deepStrictEqual(session?.value, { sessionId: resumeHandle });
        assert.deepNestedInclude(
          Array.from(events).find((event) => event.type === "RUN_STARTED"),
          { runId: "run-cursor-test", threadId: resumedSessionId },
        );
      }),
    30_000,
  );

  it.effect(
    "preserves metered ACP usage instead of estimating it",
    () =>
      Effect.gen(function* () {
        const checkout = yield* Effect.acquireRelease(
          Effect.promise(() => localProcessSandbox({}).create({})),
          (sandbox) => Effect.promise(() => sandbox.destroy()),
        );
        const runner = cursorRunner({
          name: cursorName,
          agentBin: `node ${fakeCursorAgent} --metered`,
        });

        const events = yield* Stream.runCollect(runner.run(request(checkout.id)));
        const finished = events.at(-1);

        assert.deepStrictEqual(finished && agUiUsage(finished), {
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
        });
      }),
    30_000,
  );

  it.effect(
    "refuses a blocking Cursor extension without hanging the turn",
    () =>
      Effect.gen(function* () {
        const checkout = yield* Effect.acquireRelease(
          Effect.promise(() => localProcessSandbox({}).create({})),
          (sandbox) => Effect.promise(() => sandbox.destroy()),
        );
        const runner = cursorRunner({
          name: cursorName,
          agentBin: `node ${fakeCursorAgent} --blocking-extension`,
        });

        const events = yield* Stream.runCollect(runner.run(request(checkout.id)));

        assert.isTrue(Array.from(events).some(agUiIsStructuredOutputComplete));
        assert.strictEqual(events.at(-1)?.type, "RUN_FINISHED");
      }),
    30_000,
  );

  it.effect(
    "allows a command Cursor asks permission for, because a headless Run has nobody to answer",
    () =>
      Effect.gen(function* () {
        const checkout = yield* Effect.acquireRelease(
          Effect.promise(() => localProcessSandbox({}).create({})),
          (sandbox) => Effect.promise(() => sandbox.destroy()),
        );
        const base = request(checkout.id);
        const fullRequest = {
          ...base,
          plan: new RunPlan({
            ...base.plan,
            harness: { ...base.plan.harness, profile: "full" },
            sandbox: { ...base.plan.sandbox, policy: "full" },
          }),
        } satisfies Harness.HarnessRequest;
        const runner = cursorRunner({
          name: cursorName,
          agentBin: `node ${fakeCursorAgent} --request-command-permission`,
        });

        const events = yield* Stream.runCollect(runner.run(fullRequest));
        const output = Array.from(events)
          .filter(AgUiEvent.guards.TEXT_MESSAGE_CONTENT)
          .map(({ delta }) => delta ?? "")
          .join("");

        assert.deepStrictEqual(decodePermissionOutcome(output), {
          outcome: "selected",
          optionId: "allow-once",
        });
      }),
    30_000,
  );

  it.effect(
    "exposes a new handle when ACP silently falls back after rejected load",
    () =>
      Effect.gen(function* () {
        const checkout = yield* Effect.acquireRelease(
          Effect.promise(() => localProcessSandbox({}).create({})),
          (sandbox) => Effect.promise(() => sandbox.destroy()),
        );
        const resumedRequest = {
          ...request(checkout.id),
          session: resumedSessionId,
        } satisfies Harness.HarnessRequest;
        const resumedStore = {
          ...sessionStore,
          resumeHandle: () => Effect.succeed("missing-cursor-session"),
        };
        const runner = cursorRunner({
          name: cursorName,
          agentBin: `node ${fakeCursorAgent} --reject-load`,
        });

        const events = yield* Stream.runCollect(
          runner.run(resumedRequest).pipe(Stream.provideService(SessionStore.SessionStore, resumedStore)),
        );
        const session = Array.from(events).find(
          (event) => AgUiEvent.guards.CUSTOM(event) && event.name === "cursor.session-id",
        );

        assert.deepStrictEqual(session?.value, { sessionId: "fake-cursor-session" });
      }),
    30_000,
  );

  it.effect(
    "surfaces post-launch transport failures through the Harness runner",
    () =>
      Effect.gen(function* () {
        const checkout = yield* Effect.acquireRelease(
          Effect.promise(() => localProcessSandbox({}).create({})),
          (sandbox) => Effect.promise(() => sandbox.destroy()),
        );
        const runner = cursorRunner({ name: cursorName, agentBin: "missing-cursor-agent-151" });

        const error = yield* runner.run(request(checkout.id)).pipe(Stream.runDrain, Effect.flip);

        assert.strictEqual(error.reason, "turn");
        assert.isTrue(error.retryable);
      }),
    30_000,
  );

  it.effect(
    "probes an authenticated Cursor Run that loads a Run Plan Skill through load_skill when enabled",
    () =>
      Effect.gen(function* () {
        const enabled = yield* Config.String("COGWORK_LIVE_CURSOR_PROBE").pipe(Config.withDefault("0"));
        if (enabled !== "1") return;
        const fs = yield* FileSystem.FileSystem;
        const checkout = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-cursor-probe-checkout-" });
        const skillRoot = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-cursor-probe-skill-" });
        const skillFile = `${skillRoot}/SKILL.md`;
        yield* fs.writeFileString(
          skillFile,
          "---\nname: probe-canary\ndescription: Holds the secret word for the Cursor probe.\n---\nThe secret word is PERIWINKLE-42.",
        );
        const base = request(checkout);
        const probeRequest = {
          ...base,
          plan: new RunPlan({
            ...base.plan,
            harness: { ...base.plan.harness, profile: "full" },
            sandbox: {
              workspace: checkout,
              policy: "full",
              commands: { allow: [], deny: [] },
              connections: [],
            },
            skills: [{ identity: "local:repo/skill/probe-canary", name: "probe-canary", source: skillFile }],
            messages: [
              {
                role: "user",
                content:
                  "Load the Skill named probe-canary with the load_skill tool. Reply with only the secret word that Skill holds.",
              },
            ],
            structuredOutput: null,
          }),
        } satisfies Harness.HarnessRequest;

        const events = yield* Harness.make([cursorRunner({ name: cursorName })])
          .run(probeRequest)
          .pipe(Stream.runCollect);
        const answer = Array.from(events)
          .filter(AgUiEvent.guards.TEXT_MESSAGE_CONTENT)
          .map(({ delta }) => delta ?? "")
          .join("");

        assert.include(answer, "PERIWINKLE-42");
        assert.deepStrictEqual(yield* fs.readDirectory(checkout), []);
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    // A real Cursor turn with a bridged tool call; the 5-second vitest default can never fit it.
    240_000,
  );
});

describe("cursorModelOptions", () => {
  it("turns a resolved handle into Cursor's resume sessionId", () => {
    assert.deepStrictEqual(cursorModelOptions("cursor-abc"), { sessionId: "cursor-abc" });
  });

  it("omits sessionId when there is no handle to resume from", () => {
    assert.deepStrictEqual(cursorModelOptions(null), {});
  });
});

describe("estimatedUsage", () => {
  it("counts tokens as ceil(chars / 4) and marks the result estimated", () => {
    assert.deepStrictEqual(estimatedUsage(40, 20), {
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      estimated: true,
    });
  });

  it("rounds partial tokens up so any output still shows a count", () => {
    assert.deepStrictEqual(estimatedUsage(3, 1), {
      promptTokens: 1,
      completionTokens: 1,
      totalTokens: 2,
      estimated: true,
    });
  });
});
