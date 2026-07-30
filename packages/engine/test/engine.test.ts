import { DaemonRpcs, WorkItemId } from "@clanker-forge/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as RpcTest from "effect/unstable/rpc/RpcTest";
import * as Daemon from "../src/Daemon";
import * as Reconcile from "../src/Reconcile";
import * as Registry from "../src/Registry";
import type { ObservedItem } from "../src/WorkSource";
import * as WorkSource from "../src/WorkSource";

const validModule: Registry.LoadedWorkspace = {
  source: "example.workspace.ts",
  value: {
    name: "example",
    checkoutPath: "/repos/example",
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
    assert.strictEqual(state.workspaces[0]?.config.name, "example");
    assert.strictEqual(state.failures.length, 2);
    assert.deepStrictEqual(state.failures.map((f) => f.source).sort(), [
      "broken.workspace.ts",
      "unreadable.workspace.ts",
    ]);
  });

  it("isolates a second file that reuses a registered workspace name", () => {
    const duplicate: Registry.LoadedWorkspace = {
      source: "example-copy.workspace.ts",
      value: validModule.value,
    };
    const state = Registry.buildRegistry({ loaded: [validModule, duplicate], failures: [] });
    assert.strictEqual(state.workspaces.length, 1);
    assert.strictEqual(state.failures.length, 1);
    assert.strictEqual(state.failures[0]?.source, "example-copy.workspace.ts");
  });
});

describe("decide", () => {
  const registered = Registry.buildRegistry({ loaded: [validModule], failures: [] });

  it("emits a registration event for a valid, unseen config", () => {
    const events = Registry.decide(Registry.emptyRegistry, {
      type: "register-workspace",
      source: validModule.source,
      module: validModule.value,
    });
    assert.strictEqual(events[0]?.type, "workspace.registered");
  });

  it("rejects a config whose name is already registered", () => {
    const events = Registry.decide(registered, {
      type: "register-workspace",
      source: "example-dup.workspace.ts",
      module: validModule.value,
    });
    assert.strictEqual(events[0]?.type, "workspace.registration-failed");
  });

  it("turns a decode failure into a registration-failed event", () => {
    const events = Registry.decide(Registry.emptyRegistry, {
      type: "register-workspace",
      source: malformedModule.source,
      module: malformedModule.value,
    });
    assert.strictEqual(events[0]?.type, "workspace.registration-failed");
  });

  it("passes an import failure straight through as a registration-failed event", () => {
    const events = Registry.decide(Registry.emptyRegistry, {
      type: "record-import-failure",
      source: "unreadable.workspace.ts",
      message: "boom",
    });
    assert.deepStrictEqual(events, [
      { type: "workspace.registration-failed", source: "unreadable.workspace.ts", message: "boom" },
    ]);
  });
});

describe("reconcile worker", () => {
  const registryLayer = Layer.succeed(Registry.WorkspaceRegistry, Registry.buildRegistry(sampleResult));

  const workerLayer = Reconcile.layer.pipe(
    Layer.provide(Layer.mergeAll(registryLayer, WorkSource.emptyLayer)),
  );

  it.effect("emits a receipt reflecting the registry when a reconcile is submitted", () =>
    Effect.gen(function* () {
      const worker = yield* Reconcile.ReconcileWorker;
      const receipt = yield* worker.submit();
      assert.strictEqual(receipt.workspaces, 1);
      assert.strictEqual(receipt.failures, 2);
      assert.strictEqual(receipt.pendingWork, 0);
      assert.strictEqual(receipt.paused, 0);
    }).pipe(Effect.provide(workerLayer), Effect.scoped),
  );

  const id = Schema.decodeSync(WorkItemId);
  const eligibleItem: ObservedItem = {
    id: id("AUD-1"),
    title: "first ticket",
    roles: ["ready-for-agent"],
    claim: null,
    attempts: [],
    pr: null,
  };
  const stub = (service: Partial<WorkSource.WorkSourceService>): WorkSource.WorkSourceService => ({
    observe: () => Effect.succeed([]),
    claim: () => Effect.void,
    release: () => Effect.void,
    recordAttempt: () => Effect.void,
    ...service,
  });

  const workingSource = Layer.succeed(
    WorkSource.WorkSource,
    stub({ observe: () => Effect.succeed([eligibleItem]) }),
  );
  const workerWithWork = Reconcile.layer.pipe(Layer.provide(Layer.mergeAll(registryLayer, workingSource)));

  it.effect("classifies observed work into the eligible set per workspace", () =>
    Effect.gen(function* () {
      const worker = yield* Reconcile.ReconcileWorker;
      const receipt = yield* worker.submit();
      assert.strictEqual(receipt.pendingWork, 1);
      assert.strictEqual(receipt.paused, 0);
      const snapshot = yield* worker.snapshot;
      assert.strictEqual(snapshot.workspaces[0]?.eligible[0]?.stage, "implement");
    }).pipe(Effect.provide(workerWithWork), Effect.scoped),
  );

  const authFailingSource = Layer.succeed(
    WorkSource.WorkSource,
    stub({
      observe: () =>
        Effect.fail(
          new WorkSource.WorkSourceError({
            reason: "auth",
            message: "GitHub authentication failed (401)",
          }),
        ),
    }),
  );
  const workerWithAuthFailure = Reconcile.layer.pipe(
    Layer.provide(Layer.mergeAll(registryLayer, authFailingSource)),
  );

  it.effect("pauses a workspace on auth failure instead of failing the tick", () =>
    Effect.gen(function* () {
      const worker = yield* Reconcile.ReconcileWorker;
      const receipt = yield* worker.submit();
      assert.strictEqual(receipt.paused, 1);
      assert.strictEqual(receipt.pendingWork, 0);
      const state = (yield* worker.snapshot).workspaces[0];
      assert.strictEqual(state?.poll.status, "paused");
      assert.strictEqual(
        state?.poll.status === "paused" ? state.poll.message : null,
        "GitHub authentication failed (401)",
      );
    }).pipe(Effect.provide(workerWithAuthFailure), Effect.scoped),
  );
});

describe("daemon status over rpc", () => {
  const registryLayer = Layer.succeed(Registry.WorkspaceRegistry, Registry.buildRegistry(sampleResult));
  const workerLayer = Reconcile.layer.pipe(
    Layer.provide(Layer.mergeAll(registryLayer, WorkSource.emptyLayer)),
  );
  const layer = Daemon.handlersLayer.pipe(
    Layer.provideMerge(Daemon.daemonInfoLayer),
    Layer.provideMerge(workerLayer),
    Layer.provideMerge(registryLayer),
  );

  it.effect("reports health, registered workspaces, their derived work, and failures", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(DaemonRpcs);
      const status = yield* client.GetStatus();
      assert.strictEqual(status.health, "running");
      assert.strictEqual(status.workspaces.length, 1);
      assert.strictEqual(status.workspaces[0]?.name, "example");
      assert.strictEqual(status.workspaces[0]?.workSource, "linear");
      assert.strictEqual(status.workspaces[0]?.poll.status, "ok");
      assert.deepStrictEqual(status.workspaces[0]?.eligible, []);
      assert.strictEqual(status.failures.length, 2);
      assert.isAtLeast(status.uptimeMillis, 0);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
});
