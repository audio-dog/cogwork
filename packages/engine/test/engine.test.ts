import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/unstable/rpc/RpcTest";
import * as Daemon from "../src/Daemon";
import { DaemonRpcs } from "../src/Protocol";
import * as Registry from "../src/Registry";

const validModule: Registry.LoadedWorkspace = {
  source: "audiodog.workspace.ts",
  value: {
    name: "audiodog",
    checkoutPath: "/repos/audiodog",
    workSource: { type: "linear" },
    harness: { preferred: "cursor" },
  },
};

const malformedModule: Registry.LoadedWorkspace = {
  source: "broken.workspace.ts",
  value: { name: "missing required fields" },
};

const sampleResult: Registry.LoadResult = {
  loaded: [validModule, malformedModule],
  failures: [{ source: "unreadable.workspace.ts", message: "boom" }],
};

describe("buildRegistry", () => {
  it("registers valid configs and isolates malformed and unreadable ones", () => {
    const state = Registry.buildRegistry(sampleResult);
    assert.strictEqual(state.workspaces.length, 1);
    assert.strictEqual(state.workspaces[0]?.config.name, "audiodog");
    assert.strictEqual(state.failures.length, 2);
    assert.deepStrictEqual(state.failures.map((f) => f.source).sort(), [
      "broken.workspace.ts",
      "unreadable.workspace.ts",
    ]);
  });
});

describe("daemon status over rpc", () => {
  const layer = Daemon.handlersLayer.pipe(
    Layer.provideMerge(Daemon.daemonInfoLayer),
    Layer.provideMerge(Layer.succeed(Registry.WorkspaceRegistry, Registry.buildRegistry(sampleResult))),
  );

  it.effect("reports health, registered workspaces, and registration failures", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const status = yield* client.GetStatus();
      assert.strictEqual(status.health, "running");
      assert.strictEqual(status.workspaces.length, 1);
      assert.strictEqual(status.workspaces[0]?.name, "audiodog");
      assert.strictEqual(status.workspaces[0]?.workSource, "linear");
      assert.strictEqual(status.failures.length, 2);
      assert.isAtLeast(status.uptimeMillis, 0);
    }).pipe(Effect.provide(layer)),
  );
});
