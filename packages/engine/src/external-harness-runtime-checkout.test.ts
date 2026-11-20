import { type AgUiEvent, agUiIsFileDiffUnavailableEvent, type RunId, RunPlan } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import { EventType } from "@tanstack/ai";
import { getSandbox } from "@tanstack/ai-sandbox";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";

import { externalHarnessRunner } from "./external-harness-runtime";
import { mergeCheckoutFileDiffs } from "./external-harness-runtime-events";
import {
  ControlledProbe,
  descriptor,
  freshSession,
  harnessRunnerLayer,
  hostAuthentication,
  makeHarness,
  request,
  resumedSession,
  runtimeCapabilities,
  secondCheckoutRunId,
  terminalEvents,
} from "./external-harness-runtime-fixtures";
import { make } from "./harness";

describe("external Harness runtime checkout", { timeout: 30_000 }, () => {
  it.layer(harnessRunnerLayer)((it) => {
    it.effect("ends a Run whose checkout feed never sees an event", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const checkout = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-harness-feed-" });
        const base = descriptor(terminalEvents, new ControlledProbe());
        const harness = makeHarness({ ...base, transport: { runtimeFileDiffFeed: true } });
        const seen: Array<AgUiEvent> = [];

        yield* harness
          .run({
            plan: RunPlan.make({ ...request, sandbox: { ...request.sandbox, workspace: checkout } }),
            session: freshSession,
            mcpCredentials: new Map(),
          })
          .pipe(Stream.runForEach((event) => Effect.sync(() => seen.push(event))));

        assert.isFalse(
          seen.some((event) => event.type === EventType.CUSTOM && event.name === "sandbox.file"),
        );
        assert.deepNestedInclude(seen.at(-1), { type: EventType.RUN_FINISHED });
        assert.lengthOf(
          seen.filter((event) => event.type === EventType.RUN_FINISHED),
          1,
        );
      }),
    );

    it.effect("warns before finishing when the checkout diff feed dies", () =>
      Effect.gen(function* () {
        const harnessEvents = Stream.fromIterable([
          { type: "RUN_STARTED" } satisfies AgUiEvent,
          { type: "RUN_FINISHED", finishReason: "stop" } satisfies AgUiEvent,
        ]);
        const output = yield* mergeCheckoutFileDiffs(harnessEvents, () =>
          Stream.fail(new Error("raw external watcher failure")),
        ).pipe(Effect.flatMap(Stream.runCollect));
        const warningIndex = output.findIndex(agUiIsFileDiffUnavailableEvent);
        const finishedIndex = output.findIndex((event) => event.type === EventType.RUN_FINISHED);

        assert.isAtLeast(warningIndex, 0);
        assert.isAbove(finishedIndex, warningIndex);
        assert.strictEqual(output.at(-1)?.type, EventType.RUN_FINISHED);
      }),
    );

    it.effect("keeps Operating Instructions resources host-provisioned and readable", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const checkout = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-harness-checkout-" });
        const resourceDirectory = yield* fs.makeTempDirectoryScoped({
          prefix: "cogwork-operating-instructions-",
        });
        const resource = `${resourceDirectory}/GUIDE.md`;
        yield* fs.writeFileString(resource, "supporting guide");
        const probe = new ControlledProbe();
        const reads: Array<string> = [];
        probe.inspect = (options) => {
          const sandbox = getSandbox(runtimeCapabilities(options));
          return sandbox.process
            .exec(
              `node -e 'process.stdout.write(require("node:fs").readFileSync(process.argv[1], "utf8"))' '${resource}'`,
            )
            .then((result) => {
              reads.push(result.stdout);
            });
        };
        const plan = RunPlan.make({
          ...request,
          sandbox: { ...request.sandbox, workspace: checkout },
          operatingInstructions: {
            name: "implement-agent",
            path: resourceDirectory,
            resources: [{ source: resource, content: "supporting guide" }],
          },
        });
        const base = descriptor(terminalEvents, probe);
        const harness = make([
          externalHarnessRunner(
            { ...base, transport: {} },
            {
              authentication: hostAuthentication,
            },
          ),
        ]);

        yield* harness.run({ plan, session: freshSession, mcpCredentials: new Map() }).pipe(Stream.runDrain);

        assert.deepStrictEqual(reads, ["supporting guide"]);
        assert.isFalse(yield* fs.exists(`${checkout}/GUIDE.md`));
        assert.include(yield* fs.readFileString(`${checkout}/AGENTS.md`), resourceDirectory);
      }),
    );

    it.effect("binds each Run to its prepared checkout when a Session resumes", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const firstCheckout = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-first-checkout-" });
        const secondCheckout = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-second-checkout-" });
        const probe = new ControlledProbe();
        const observedCheckouts: Array<string> = [];
        probe.inspect = (options) =>
          getSandbox(runtimeCapabilities(options))
            .process.exec("pwd -P")
            .then(({ stdout }) => {
              observedCheckouts.push(stdout.trim());
            });
        const harness = make([
          externalHarnessRunner(descriptor(terminalEvents, probe), {
            authentication: hostAuthentication,
          }),
        ]);
        const runAt = (id: RunId, workspace: string) =>
          harness
            .run({
              plan: RunPlan.make({
                ...request,
                id,
                sandbox: { ...request.sandbox, workspace },
              }),
              session: resumedSession,
              mcpCredentials: new Map(),
            })
            .pipe(Stream.runDrain);

        yield* runAt(request.id, firstCheckout);
        yield* runAt(secondCheckoutRunId, secondCheckout);

        assert.deepStrictEqual(observedCheckouts, [
          yield* fs.realPath(firstCheckout),
          yield* fs.realPath(secondCheckout),
        ]);
      }),
    );
  });
});
