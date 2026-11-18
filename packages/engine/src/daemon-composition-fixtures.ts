import { HarnessName } from "@cogwork/contracts";
import type * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NetAddress from "effect/net/NetAddress";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcServer from "effect/rpc/RpcServer";
import * as Stream from "effect/Stream";
import * as Socket from "effect/socket/Socket";
import * as SocketServer from "effect/socket/SocketServer";
import { vi } from "vitest";
import * as ContextAssembler from "./context-assembler";
import * as CredentialStore from "./credential-store";
import * as Daemon from "./daemon";
import { Git, type GitService } from "./git";
import { fullHarnessExecution, type HarnessRunner } from "./harness";
import { PerformanceHealthSource } from "./performance-health-source";
import * as RunLedger from "./run-ledger";
import { WorktreeManager, type WorktreeManagerService } from "./worktree";

export const harnessName = HarnessName.make("scripted");
export const structuredOutput = {
  summary: "Ready for implementation",
  stuck: false,
  answers: { role: "ready-for-agent" },
  inputs: { comment: "Ready for implementation.", hand_off: "" },
};

export const resultEvent = (object: unknown) => ({
  type: "CUSTOM" as const,
  name: "structured-output.complete" as const,
  value: { object, raw: JSON.stringify(object) },
});

export const runner: HarnessRunner = {
  name: harnessName,
  sessionKind: "owned-transcript",
  projectedMembers: [],
  planMiddleware: ["sandbox", "persistence", "instruction-context"],
  execution: fullHarnessExecution,
  capabilities: {
    authenticationModes: ["host"],
    session: { affinity: "portable", fork: false, humanAttach: false },
    structuredOutput: "native",
    policyFidelity: "exact",
    fileEventFidelity: "absent",
    usageQuality: "none",
    readinessDiagnostics: false,
    journal: false,
    takeover: false,
  },
  authentication: { mode: "host", reference: "test" },
  catalog: { models: [] },
  readiness: () =>
    Effect.succeed({
      operational: { status: "ready", retryable: false, diagnostic: "ready" },
      installation: { status: "installed", version: "1" },
      compatibility: { status: "compatible", requirement: null },
      authentication: { mode: "host", status: "available", diagnostic: "ready" },
      diagnostics: [],
    }),
  preflight: () => Effect.void,
  run: () => Stream.succeed(resultEvent(structuredOutput)),
};

export const reconcileWorktrees = vi.fn<WorktreeManagerService["reconcile"]>(() =>
  Effect.succeed({ tornDown: [], reaped: [] }),
);

export const worktreeLayer = Layer.succeed(WorktreeManager, {
  withRunOwnershipLock: (effect) => effect,
  tryWithMaintenanceLock: Effect.asSome,
  ensure: () => Effect.die("unused"),
  operationInProgress: () => Effect.die("unused"),
  pullRequestReadiness: () => Effect.die("unused"),
  pushBranch: () => Effect.die("unused"),
  pushBranchIfAhead: () => Effect.die("unused"),
  list: () => Effect.succeed([]),
  remove: () => Effect.void,
  reconcile: reconcileWorktrees,
});

export const gitLayer = Layer.succeed(Git, {
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
  blockPush: () => Effect.die("unused"),
  allowPush: () => Effect.die("unused"),
  pushBranch: () => Effect.die("unused"),
} satisfies GitService);

const credentialsLayer = Layer.succeed(CredentialStore.CredentialStore, {
  resolveSource: () =>
    Effect.succeed({ source: "stored-key", token: Redacted.make("token"), identity: null }),
  bearerToken: () =>
    Effect.succeed({
      source: "stored-key",
      token: Redacted.make("token"),
      identity: null,
    }),
  persist: () => Effect.void,
  invalidate: () => Effect.void,
  providerKey: () => Effect.die("unused"),
  persistProviderKey: () => Effect.die("unused"),
  configureConnection: () => Effect.void,
  removeConnection: () => Effect.void,
} satisfies CredentialStore.CredentialStoreService);

export const contextAssemblerLayer = Layer.succeed(ContextAssembler.ContextAssembler, {
  assemble: () =>
    Effect.succeed({
      layers: [],
      operatingInstructionsName: "triage-agent",
      operatingInstructionsPath: "/skills",
      operatingInstructionResources: [],
      sources: [],
    }),
  cleanup: () => Effect.void,
});

export const socketServerLayer = (socket: Socket.Socket) =>
  Layer.succeed(SocketServer.SocketServer, {
    address: NetAddress.unixPathAddress("memory"),
    run: (handler) => handler(socket).pipe(Effect.ignore, Effect.andThen(Effect.never)),
  });

const issueResponse = (labels: ReadonlyArray<string>) => ({
  node_id: "I_issue_1",
  number: 1,
  title: "Triage me",
  html_url: "https://github.com/owner/repo/issues/1",
  labels,
  assignees: [],
  body: "Please triage this issue.",
  state: "open",
  created_at: "2026-11-01T12:00:00Z",
});

export const jsonResponse = (body: unknown = {}, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export const advancingClock = () => {
  const state = { millis: 0 };
  const nextMillis = () => {
    const current = state.millis;
    state.millis = current + 1;
    return current;
  };
  const nextNanos = () => BigInt(nextMillis()) * 1_000_000n;
  return {
    currentTimeMillisUnsafe: nextMillis,
    currentTimeMillis: Effect.sync(nextMillis),
    currentTimeNanosUnsafe: nextNanos,
    currentTimeNanos: Effect.sync(nextNanos),
    monotonicTimeNanosUnsafe: nextNanos,
    monotonicTimeNanos: Effect.sync(nextNanos),
    sleep: () => Effect.never,
  } satisfies Clock.Clock;
};

function makeFixture() {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-daemon-composition-" });
    const checkoutPath = path.join(root, "repo");
    yield* fs.makeDirectory(checkoutPath);
    const labels = ["needs-triage"];
    const comments: Array<Record<string, unknown>> = [];
    const fetchStub = vi.fn<typeof globalThis.fetch>((input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/user") {
        return Promise.resolve(jsonResponse({ login: "owner" }));
      }
      if (request.method === "POST" && url.pathname === "/graphql") {
        return Promise.resolve(
          jsonResponse({
            data: {
              repository: {
                pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
              },
            },
          }),
        );
      }
      if (request.method === "GET" && url.pathname.endsWith("/issues/1/comments")) {
        return Promise.resolve(jsonResponse(comments));
      }
      if (request.method === "POST" && url.pathname.endsWith("/issues/1/comments")) {
        return request.json().then((unknown) => {
          const payload = unknown as { readonly body: string };
          comments.push({
            id: 1,
            body: payload.body,
            created_at: "2026-11-01T12:01:00Z",
            author_association: "MEMBER",
            user: { login: "cogwork", type: "Bot" },
          });
          return jsonResponse({}, 201);
        });
      }
      if (request.method === "POST" && url.pathname.endsWith("/issues/1/labels")) {
        return request.json().then((unknown) => {
          const payload = unknown as { readonly labels: ReadonlyArray<string> };
          labels.push(...payload.labels);
          return jsonResponse(payload.labels.map((name) => ({ name })));
        });
      }
      if (request.method === "GET" && url.pathname.endsWith("/issues/1")) {
        return Promise.resolve(jsonResponse(issueResponse(labels)));
      }
      if (request.method === "GET" && url.pathname.endsWith("/issues")) {
        return Promise.resolve(jsonResponse([issueResponse(labels)]));
      }
      return Promise.resolve(jsonResponse([]));
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
      checkoutPath,
      fetchStub,
      clientLayer,
      serverLayer: Daemon.serverLayer({
        transport,
        credentials: credentialsLayer,
        contextAssembler: contextAssemblerLayer,
        runLedger: RunLedger.layerMemoryCore,
        controlStorePath: path.join(root, "control.db"),
        userAgentsDir: path.join(root, ".agents"),
        worktrees: worktreeLayer,
        harnessRunners: [runner],
        appVersion: "test",
        performanceEvidenceRoot: path.join(root, "perf"),
        performanceHealth: Layer.succeed(PerformanceHealthSource, {
          snapshot: Effect.succeed({ sampledAtMillis: 0 }),
        }),
      }).pipe(Layer.provide(gitLayer)),
    };
  });
}

export class Fixture extends Context.Service<Fixture, Effect.Success<ReturnType<typeof makeFixture>>>()(
  "@cogwork/engine/daemon-composition-fixtures/Fixture",
) {
  static readonly layer = Layer.effect(Fixture, makeFixture());
}
