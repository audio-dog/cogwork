// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  connectionIdOf,
  DaemonEvent,
  DaemonRpcs,
  HarnessName,
  WorkflowDocument,
  WorkflowPublishRefused,
  WorkflowSwitchRefused,
  WorkspaceConfig,
} from "@cogwork/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import * as Socket from "effect/unstable/socket/Socket";
import * as SocketServer from "effect/unstable/socket/SocketServer";
import { afterEach, vi } from "vitest";
import * as ContextAssembler from "./context-assembler";
import * as CredentialStore from "./credential-store";
import * as Daemon from "./daemon";
import { Git, type GitService } from "./git";
import { fullHarnessExecution, type HarnessRunner } from "./harness";
import { IssueTracker } from "./issue-tracker";
import { PerformanceHealthSource } from "./performance-health-source";
import type { RegisteredWorkspace } from "./projector";
import { ReconcileWorker } from "./reconcile";
import * as RunLedger from "./run-ledger";
import { WorktreeManager } from "./worktree";

const pushSchemaMock = vi.hoisted(() => vi.fn());
vi.mock("drizzle-kit/payload/sqlite", () =>
  vi
    .importActual<typeof import("drizzle-kit/payload/sqlite")>("drizzle-kit/payload/sqlite")
    .then((actual) => {
      pushSchemaMock.mockImplementation(actual.pushSchema);
      return { ...actual, pushSchema: pushSchemaMock };
    }),
);

const healthSourceLayer = (snapshot: Effect.Effect<{ readonly sampledAtMillis: number }>) =>
  Layer.succeed(PerformanceHealthSource, { snapshot });

const interruptionGate = Latch.makeUnsafe();

const worktreeLayer = Layer.succeed(WorktreeManager, {
  withRunOwnershipLock: (effect) => effect,
  tryWithMaintenanceLock: Effect.asSome,
  ensure: () => Effect.die("unused"),
  pullRequestReadiness: () => Effect.die("unused"),
  list: () => Effect.succeed([]),
  remove: () => Effect.void,
  reconcile: () => Effect.succeed({ tornDown: [], reaped: [] }),
});

const gitLayer = Layer.succeed(Git, {
  fetch: () => Effect.die("unused"),
  remoteBranchExists: () => Effect.die("unused"),
  addWorktree: () => Effect.die("unused"),
  removeWorktree: () => Effect.die("unused"),
  listWorktrees: () => Effect.die("unused"),
  fastForward: () => Effect.die("unused"),
  divergence: () => Effect.die("unused"),
  operationInProgress: () => Effect.die("unused"),
  rebase: () => Effect.die("unused"),
  remoteUrl: () => Effect.succeed("git@github.com:owner/repo.git"),
} satisfies GitService);

const stubRunner: HarnessRunner = {
  name: Schema.decodeSync(HarnessName)("cursor"),
  sessionKind: "opaque-handle",
  projectedMembers: [],
  planMiddleware: [],
  execution: fullHarnessExecution,
  capabilities: {
    authenticationModes: ["host"],
    session: { affinity: "runtime-host", fork: false, humanAttach: "codex-cli" },
    structuredOutput: "none",
    policyFidelity: "exact",
    fileEventFidelity: "absent",
    usageQuality: "none",
    readinessDiagnostics: false,
    journal: false,
    takeover: false,
  },
  authentication: { mode: "host", reference: "test login" },
  catalog: {
    models: [{ value: "test", label: "Test" }],
  },
  readiness: () =>
    Effect.succeed({
      operational: { status: "ready", retryable: false, diagnostic: "Test runner is ready" },
      installation: { status: "installed", version: "1" },
      compatibility: { status: "compatible", requirement: ">=1" },
      authentication: { mode: "host", status: "available", diagnostic: "test login available" },
      diagnostics: [],
    }),
  preflight: () => Effect.void,
  run: () => Stream.empty,
};

const contextAssemblerLayer = Layer.succeed(ContextAssembler.ContextAssembler, {
  assemble: () =>
    Effect.succeed({
      layers: [],
      operatingInstructionsPath: "/skills",
      operatingInstructionResources: [],
      sources: [],
    }),
  cleanup: () => Effect.void,
});

const socketServerLayer = (socket: Socket.Socket) =>
  Layer.succeed(SocketServer.SocketServer, {
    address: { _tag: "UnixAddress", path: "memory" },
    run: (handler) =>
      handler(socket).pipe(
        Effect.ignore,
        Effect.andThen(
          interruptionGate.await.pipe(Effect.flatMap(() => Effect.die("interruption gate opened"))),
        ),
      ),
  });

const inspectUnavailableDaemon = Effect.fn("test.inspectUnavailableDaemon")(function* () {
  yield* Daemon.bootstrap;
  const heartbeats = yield* Effect.forkChild(
    Daemon.heartbeats({ pollIntervalMillis: 1000, drain: { graceMillis: 0, abort: Effect.void } }),
  );
  yield* TestClock.adjust("1 minute");
  const worker = yield* ReconcileWorker;
  const reconciled = yield* worker.snapshot;
  const heartbeatsExit = heartbeats.pollUnsafe();
  yield* Fiber.interrupt(heartbeats);
  const rpc = yield* RpcClient.make(DaemonRpcs);
  const runs = yield* rpc.ListRuns();
  const status = yield* rpc.GetStatus();
  const catalogs = yield* rpc.GetHarnessCatalogs();
  const workflowCatalog = yield* rpc.GetWorkflowCatalog();
  const readiness = yield* Effect.result(rpc.GetHarnessReadiness());
  return { runs, status, reconciled, heartbeatsExit, catalogs, workflowCatalog, readiness };
});

const connectedWorkspace: RegisteredWorkspace = {
  source: "control-store:github",
  repository: "owner/repo",
  contributions: [],
  config: Schema.decodeSync(WorkspaceConfig)({
    name: "github",
    checkoutPath: "/repos/github",
    issueTracker: {
      type: "github",
      connectionId: connectionIdOf("github", "acme"),
    },
  }),
};

const storedGitHubCredentials = Layer.succeed(CredentialStore.CredentialStore, {
  resolveSource: () => Effect.die("unexpected credential source resolution"),
  bearerToken: () =>
    Effect.succeed({ source: "stored-key", token: Redacted.make("stored-token"), identity: null }),
  persist: () => Effect.void,
  invalidate: () => Effect.void,
  providerKey: () => Effect.die("unexpected provider key"),
  persistProviderKey: () => Effect.die("unexpected provider key persist"),
  configureConnection: () => Effect.void,
  removeConnection: () => Effect.void,
} satisfies CredentialStore.CredentialStoreService);

function makeGitHubServerFixture() {
  return Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.sync(() => mkdtempSync(join(tmpdir(), "cogwork-github-credential-"))),
      (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
    );
    vi.stubEnv("GITHUB_TOKEN", "fallback-token");
    const fetchStub = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const body = url === "https://api.github.com/user" ? { login: "connected-account" } : [];
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });
    vi.stubGlobal("fetch", fetchStub);
    const toServer = new TransformStream<Uint8Array, Uint8Array>();
    const toClient = new TransformStream<Uint8Array, Uint8Array>();
    const client = yield* Socket.fromTransformStream(
      Effect.succeed({ readable: toClient.readable, writable: toServer.writable }),
    );
    const server = yield* Socket.fromTransformStream(
      Effect.succeed({ readable: toServer.readable, writable: toClient.writable }),
    );
    const transport = RpcServer.layerProtocolSocketServer.pipe(Layer.provide(socketServerLayer(server)));
    const clientLayer = RpcClient.layerProtocolSocket().pipe(
      Layer.provide(Layer.succeed(Socket.Socket, client)),
      Layer.provide(Daemon.serializationLayer),
    );
    return {
      fetchStub,
      clientLayer,
      serverLayer: Daemon.serverLayer({
        transport,
        credentials: storedGitHubCredentials,
        contextAssembler: contextAssemblerLayer,
        runLedger: RunLedger.layerMemoryCore,
        controlStorePath: join(root, "control.db"),
        userAgentsDir: join(root, ".agents"),
        worktrees: worktreeLayer,
        harnessRunners: [stubRunner],
        appVersion: "test",
        performanceEvidenceRoot: join(root, "perf"),
        performanceHealth: healthSourceLayer(Effect.succeed({ sampledAtMillis: 0 })),
      }).pipe(Layer.provide(gitLayer)),
    };
  });
}

class GitHubServerFixture extends Context.Service<
  GitHubServerFixture,
  Effect.Success<ReturnType<typeof makeGitHubServerFixture>>
>()("@cogwork/engine/daemon-composition.test/GitHubServerFixture") {
  static readonly layer = Layer.effect(GitHubServerFixture, makeGitHubServerFixture());
}

const githubServerTestLayer = () =>
  Layer.unwrap(
    Effect.map(GitHubServerFixture, ({ clientLayer, serverLayer }) =>
      Layer.merge(serverLayer, clientLayer).pipe(Layer.provide(NodeServices.layer)),
    ),
  ).pipe(Layer.provideMerge(GitHubServerFixture.layer));

function makeUnavailableServerFixture() {
  return Effect.gen(function* () {
    pushSchemaMock.mockRejectedValueOnce(new Error("unexpected converge failure"));
    const controlStore = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const dir = mkdtempSync(join(tmpdir(), "cogwork-poisoned-store-"));
        const path = join(dir, "control.db");
        const db = new DatabaseSync(path);
        db.close();
        return { dir, path };
      }),
      ({ dir }) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
    );
    const toServer = new TransformStream<Uint8Array, Uint8Array>();
    const toClient = new TransformStream<Uint8Array, Uint8Array>();
    const client = yield* Socket.fromTransformStream(
      Effect.succeed({ readable: toClient.readable, writable: toServer.writable }),
    );
    const server = yield* Socket.fromTransformStream(
      Effect.succeed({ readable: toServer.readable, writable: toClient.writable }),
    );
    const transport = RpcServer.layerProtocolSocketServer.pipe(Layer.provide(socketServerLayer(server)));
    const clientLayer = RpcClient.layerProtocolSocket().pipe(
      Layer.provide(Layer.succeed(Socket.Socket, client)),
      Layer.provide(Daemon.serializationLayer),
    );
    return {
      clientLayer,
      serverLayer: Daemon.serverLayer({
        transport,
        credentials: CredentialStore.layerEnv,
        contextAssembler: contextAssemblerLayer,
        runLedger: RunLedger.layerMemoryCore,
        controlStorePath: controlStore.path,
        userAgentsDir: join(controlStore.dir, ".agents"),
        worktrees: worktreeLayer,
        harnessRunners: [stubRunner],
        appVersion: "test",
        performanceEvidenceRoot: join(controlStore.dir, "perf"),
        performanceHealth: healthSourceLayer(Effect.succeed({ sampledAtMillis: 0 })),
      }).pipe(Layer.provide(gitLayer)),
    };
  });
}

class UnavailableServerFixture extends Context.Service<
  UnavailableServerFixture,
  Effect.Success<ReturnType<typeof makeUnavailableServerFixture>>
>()("@cogwork/engine/daemon-composition.test/UnavailableServerFixture") {
  static readonly layer = Layer.effect(UnavailableServerFixture, makeUnavailableServerFixture());
}

const unavailableServerTestLayer = () =>
  Layer.unwrap(
    Effect.map(UnavailableServerFixture, ({ clientLayer, serverLayer }) =>
      Layer.mergeAll(serverLayer, clientLayer).pipe(Layer.provide(NodeServices.layer)),
    ),
  ).pipe(Layer.provideMerge(UnavailableServerFixture.layer));

describe("daemon server composition", () => {
  afterEach(() => {
    pushSchemaMock.mockClear();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.effect("uses a GitHub Connection credential through the composed daemon", () =>
    Effect.gen(function* () {
      const { fetchStub } = yield* GitHubServerFixture;
      yield* (yield* IssueTracker).observe(connectedWorkspace);
      const authorization = new Headers(fetchStub.mock.calls[0]?.[1]?.headers).get("authorization");
      assert.strictEqual(authorization, "Bearer stored-token");
    }).pipe(Effect.provide(githubServerTestLayer()), Effect.scoped),
  );

  it.effect("authors and observes an incomplete Workflow through DaemonRpcs", () =>
    Effect.gen(function* () {
      yield* Daemon.bootstrap;
      const rpc = yield* RpcClient.make(DaemonRpcs);
      const document = yield* Schema.decodeEffect(WorkflowDocument)({
        name: "Draft",
        workspaces: { _tag: "Every" },
        triggers: [],
        operations: [],
      });
      const created = yield* rpc.CreateWorkflow({ document });
      const edited = yield* rpc.EditWorkflow({
        id: created.id,
        edits: [{ _tag: "SetName", name: "Edited" }],
      });
      const listed = yield* rpc.ListWorkflows();
      const fetched = yield* rpc.GetWorkflow({ id: created.id });
      const diagnostics = yield* rpc.ValidateWorkflow({ document: { name: "Malformed" } });
      const publish = yield* Effect.result(
        rpc.PublishWorkflow({ id: created.id, revision: edited.workingRevision }),
      );
      const switched = yield* Effect.result(rpc.SwitchWorkflow({ id: created.id, enabled: true }));
      const catalog = yield* rpc.GetWorkflowCatalog();
      const seed = yield* rpc
        .WatchEvents()
        .pipe(Stream.takeUntil(DaemonEvent.guards.SeedEnd), Stream.runCollect);
      const deleted = yield* rpc.DeleteWorkflow({ id: created.id });

      assert.strictEqual(edited.workingCopy.name, "Edited");
      assert.deepStrictEqual(
        listed.workflows.map(({ id }) => id),
        [created.id],
      );
      assert.strictEqual(fetched.id, created.id);
      assert.deepStrictEqual(
        diagnostics.map(({ code }) => code),
        ["schema"],
      );
      assert.isTrue(Result.isFailure(publish) && Schema.is(WorkflowPublishRefused)(publish.failure));
      assert.isTrue(Result.isFailure(switched) && Schema.is(WorkflowSwitchRefused)(switched.failure));
      assert.lengthOf(catalog.entries, 5);
      assert.isTrue(
        [...seed].some((event) => event._tag === "WorkflowChanged" && event.workflow.id === created.id),
      );
      assert.strictEqual(deleted, created.id);
    }).pipe(Effect.provide(githubServerTestLayer()), Effect.scoped),
  );

  it.effect("serves RPC without booting dispatch when the Control store is unavailable", () =>
    Effect.gen(function* () {
      const result = yield* inspectUnavailableDaemon();

      assert.deepStrictEqual(result.runs, []);
      assert.strictEqual(result.status.health, "store-unavailable");
      assert.strictEqual(result.reconciled.generation, 0);
      assert.deepStrictEqual(result.reconciled.workspaces, []);
      assert.isUndefined(result.heartbeatsExit);
      assert.strictEqual(result.status.scheduler.globalInFlight, 0);
      assert.deepStrictEqual(result.status.workspaces, []);
    }).pipe(Effect.provide(unavailableServerTestLayer()), Effect.scoped),
  );

  it.effect("serves catalogs without the Control store and fails readiness closed", () =>
    Effect.gen(function* () {
      const result = yield* inspectUnavailableDaemon();
      assert.deepStrictEqual(
        result.catalogs.map(({ harness }) => harness),
        ["cursor"],
      );
      assert.deepStrictEqual(
        result.workflowCatalog.entries.map(({ name }) => name),
        ["Notify me", "Wait for my approval", "Withdraw the pending approval", "Hand to me", "Stop"],
      );
      assert.isTrue(Result.isFailure(result.readiness));
    }).pipe(Effect.provide(unavailableServerTestLayer()), Effect.scoped),
  );
});
