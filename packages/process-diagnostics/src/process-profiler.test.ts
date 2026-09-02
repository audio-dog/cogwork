import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { makeProcessProfiler, type ProcessInspector, type ProcessProfilerPlatform } from "./process-profiler";

const makeProbe = () => {
  const calls: string[] = [];
  const files = new Map<string, string>();
  const inspector: ProcessInspector = {
    takeHeapSnapshot: (write) =>
      Effect.sync(() => {
        calls.push("heap");
        write("first");
        write("second");
      }),
    startCpuProfile: Effect.sync(() => calls.push("cpu:start")),
    stopCpuProfile: Effect.sync(() => {
      calls.push("cpu:stop");
      return { nodes: [{ id: 1 }] };
    }),
  };
  const platform: ProcessProfilerPlatform = {
    pid: 42,
    joinPath: (...segments) => segments.join("/"),
    currentTimeMillis: Effect.succeed(1_234),
    openInspector: Effect.acquireRelease(Effect.succeed(inspector), () =>
      Effect.sync(() => calls.push("disconnect")),
    ),
    ensureDirectory: (directory) => Effect.sync(() => calls.push(`mkdir:${directory}`)),
    writeFile: (path, contents) => Effect.sync(() => files.set(path, contents)),
    writeChunks: (path, produce) => {
      const chunks: string[] = [];
      return produce((chunk) => chunks.push(chunk)).pipe(
        Effect.andThen(Effect.sync(() => files.set(path, chunks.join("")))),
      );
    },
  };
  return { calls, files, profiler: makeProcessProfiler(platform) };
};

describe("ProcessProfiler", () => {
  it.effect("streams a heap snapshot to a loadable artifact", () =>
    Effect.gen(function* () {
      const probe = makeProbe();
      const path = yield* probe.profiler.capture({
        _tag: "HeapSnapshot",
        directory: "/diagnostics",
      });

      assert.strictEqual(path, "/diagnostics/Heap.42.1234.heapsnapshot");
      assert.strictEqual(probe.files.get(path), "firstsecond");
      assert.deepStrictEqual(probe.calls, ["mkdir:/diagnostics", "heap", "disconnect"]);
    }),
  );

  it.effect("writes a CPU profile after the requested sample window", () =>
    Effect.gen(function* () {
      const probe = makeProbe();
      const path = yield* probe.profiler.capture({
        _tag: "CpuProfile",
        directory: "/diagnostics",
        durationMillis: 0,
      });

      assert.strictEqual(path, "/diagnostics/CPU.42.1234.cpuprofile");
      const profile = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
        probe.files.get(path) ?? "",
      );
      assert.deepStrictEqual(profile, { nodes: [{ id: 1 }] });
      assert.deepStrictEqual(probe.calls, ["mkdir:/diagnostics", "cpu:start", "cpu:stop", "disconnect"]);
    }),
  );
});
