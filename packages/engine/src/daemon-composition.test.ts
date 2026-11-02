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
  type WorkspaceId,
  WorkspaceRegistration,
} from "@cogwork/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
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
import { Scheduler } from "./scheduler";
import {
  makeMemoryTriggerObservationStore,
  TriggerObservation,
  TriggerObservationStore,
} from "./trigger-observation";
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
  pushBranch: () => Effect.die("unused"),
  pushBranchIfAhead: () => Effect.die("unused"),
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
  blockPush: () => Effect.die("unused"),
  allowPush: () => Effect.die("unused"),
  pushBranch: () => Effect.die("unused"),
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
      operatingInstructionsName: "implement-agent",
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

interface PullRequestToolCall {
  readonly workspace: WorkspaceId;
  readonly pull_request: string;
}

interface SlackReviewProbeService {
  readonly workspace: Ref.Ref<WorkspaceId | null>;
  readonly pullRequestToolCalls: Ref.Ref<ReadonlyArray<PullRequestToolCall>>;
}

class SlackReviewProbe extends Context.Service<SlackReviewProbe, SlackReviewProbeService>()(
  "@cogwork/engine/daemon-composition.test/SlackReviewProbe",
) {
  static readonly layer = Layer.effect(
    SlackReviewProbe,
    Effect.all({
      workspace: Ref.make<WorkspaceId | null>(null),
      pullRequestToolCalls: Ref.make<ReadonlyArray<PullRequestToolCall>>([]),
    }),
  );
}

const resultEvent = (object: unknown) => ({
  type: "CUSTOM" as const,
  name: "structured-output.complete" as const,
  value: { object, raw: JSON.stringify(object) },
});

const slackReviewRunner = (probe: SlackReviewProbeService): HarnessRunner => ({
  ...stubRunner,
  capabilities: { ...stubRunner.capabilities, structuredOutput: "native" },
  run: (request) => {
    const body = request.plan.workContext.prose.body;
    const executePullRequest = request.engineTools?.find(({ name }) => name === "pull-request")?.execute;
    const isReview = JSON.stringify(request.plan.structuredOutput).includes('"verdict"');
    if (!executePullRequest && isReview) return Stream.die("pull request tool is unavailable");
    if (!executePullRequest) {
      const output = [
        {
          matches: body.includes("[not-actionable]"),
          value: {
            summary: "No action needed",
            stuck: false,
            answers: { ask: "not-actionable" },
            inputs: { reply: "" },
          },
        },
        {
          matches: true,
          value: {
            summary: "Review request found",
            stuck: false,
            answers: { ask: "review-request" },
            inputs: { reply: "I am reviewing #827." },
          },
        },
      ].find(({ matches }) => matches)?.value;
      return Stream.succeed(resultEvent(output));
    }
    return Stream.fromEffect(
      Effect.gen(function* () {
        const workspace = yield* Ref.get(probe.workspace);
        if (workspace === null) return yield* Effect.die("Slack review Workspace is missing");
        const toolCall = { workspace, pull_request: "#827" } satisfies PullRequestToolCall;
        yield* Ref.update(probe.pullRequestToolCalls, (calls) => [...calls, toolCall]);
        yield* Effect.promise(() => Promise.resolve(executePullRequest(toolCall)));
        const output = [
          {
            matches: body.includes("[cannot-review]"),
            value: {
              summary: "Review needs a person",
              stuck: false,
              answers: { verdict: "cannot-review" },
              inputs: {
                pull_request: "#827",
                review_body: "",
                review_comments: [],
                approval_request: "",
                reply: "",
                hand_off: "Please review #827 manually.",
              },
              workspace,
            },
          },
          {
            matches: true,
            value: {
              summary: "Review ready",
              stuck: false,
              answers: { verdict: "approve" },
              inputs: {
                pull_request: "#827",
                review_body: "Looks good.",
                review_comments: [],
                approval_request: "Post this approval?",
                reply: "Reviewed #827.",
                hand_off: "",
              },
              workspace,
            },
          },
        ].find(({ matches }) => matches)?.value;
        return resultEvent(output);
      }),
    );
  },
});

const slackReviewCredentials = Layer.succeed(CredentialStore.CredentialStore, {
  resolveSource: () =>
    Effect.succeed({
      source: "stored-oauth",
      token: Redacted.make("slack-token"),
      identity: { organization: "T-review", actorUserId: "U-cogwork" },
    }),
  bearerToken: () =>
    Effect.succeed({
      source: "stored-oauth",
      token: Redacted.make("stored-token"),
      identity: { organization: "T-review", actorUserId: "U-cogwork" },
    }),
  persist: () => Effect.void,
  invalidate: () => Effect.void,
  providerKey: () => Effect.die("unexpected provider key"),
  persistProviderKey: () => Effect.die("unexpected provider key persist"),
  configureConnection: () => Effect.void,
  removeConnection: () => Effect.void,
} satisfies CredentialStore.CredentialStoreService);

function makeSlackReviewServerFixture() {
  return Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.sync(() => mkdtempSync(join(tmpdir(), "cogwork-slack-review-"))),
      (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
    );
    const probe = yield* SlackReviewProbe;
    const observationStore = yield* makeMemoryTriggerObservationStore;
    const baseSeconds = 1_000;
    const timestamps = {
      approve: `${baseSeconds}.100001`,
      cannotReview: `${baseSeconds}.100002`,
      notActionable: `${baseSeconds}.100003`,
    } as const;
    const messages = [
      {
        ts: timestamps.approve,
        text: "<@U-cogwork> review https://github.com/owner/repo/pull/827 [approve]",
        user: "U-requester",
        channel_id: "C-review",
      },
      {
        ts: timestamps.cannotReview,
        text: "<@U-cogwork> review https://github.com/owner/repo/pull/827 [cannot-review]",
        user: "U-requester",
        channel_id: "C-review",
      },
      {
        ts: timestamps.notActionable,
        text: "Thanks <@U-cogwork> [not-actionable]",
        user: "U-requester",
        channel_id: "C-review",
      },
    ];
    const jsonResponse = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    const fetchStub = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.hostname === "slack.com") {
        const method = url.pathname.replace("/api/", "");
        const slackResponses = {
          "search.messages": { ok: true, messages: { matches: messages } },
          "conversations.info": { ok: true, channel: { name: "reviews" } },
          "users.info": { ok: true, user: { name: "Taylor" } },
          "chat.getPermalink": {
            ok: true,
            permalink: `https://example.slack.com/archives/C-review/p${url.searchParams.get("message_ts")}`,
          },
          "conversations.replies": {
            ok: true,
            messages: messages.filter(({ ts }) => ts === url.searchParams.get("ts")),
            response_metadata: { next_cursor: "" },
          },
          "reactions.add": { ok: true },
          "chat.postMessage": { ok: true, channel: "C-review", ts: `${baseSeconds}.900001` },
        } as const;
        return Promise.resolve(jsonResponse(slackResponses[method as keyof typeof slackResponses] ?? {}));
      }
      if (url.pathname === "/user") return Promise.resolve(jsonResponse({ login: "connected-account" }));
      if (url.pathname === "/repos/owner/repo/pulls/827" && request.method === "GET") {
        return Promise.resolve(
          jsonResponse({
            number: 827,
            html_url: "https://github.com/owner/repo/pull/827",
            user: { login: "reviewer" },
            author_association: "MEMBER",
            draft: false,
            title: "Slack review template",
            body: "Adds the Slack review Workflow.",
            head: { sha: "head-sha", ref: "827-slack-review", repo: { full_name: "owner/repo" } },
            base: { sha: "base-sha", ref: "main" },
            updated_at: "2026-11-02T12:00:00Z",
          }),
        );
      }
      if (url.pathname === "/repos/owner/repo/compare/base-sha...head-sha") {
        const acceptsDiff = request.headers.get("accept") === "application/vnd.github.v3.diff";
        return Promise.resolve(acceptsDiff ? new Response("") : jsonResponse({ files: [] }));
      }
      if (url.pathname === "/repos/owner/repo/pulls/827/reviews" && request.method === "POST") {
        return Promise.resolve(jsonResponse({ id: 91 }, 201));
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
      root,
      fetchStub,
      timestamps,
      clientLayer,
      serverLayer: Daemon.serverLayer({
        transport,
        credentials: slackReviewCredentials,
        contextAssembler: contextAssemblerLayer,
        runLedger: RunLedger.layerMemoryCore,
        controlStorePath: join(root, "control.db"),
        userAgentsDir: join(root, ".agents"),
        worktrees: worktreeLayer,
        harnessRunners: [slackReviewRunner(probe)],
        appVersion: "test",
        performanceEvidenceRoot: join(root, "perf"),
        performanceHealth: healthSourceLayer(Effect.succeed({ sampledAtMillis: 0 })),
        triggerObservationStore: Layer.succeed(TriggerObservationStore, observationStore),
      }).pipe(Layer.provide(gitLayer)),
    };
  });
}

class SlackReviewServerFixture extends Context.Service<
  SlackReviewServerFixture,
  Effect.Success<ReturnType<typeof makeSlackReviewServerFixture>>
>()("@cogwork/engine/daemon-composition.test/SlackReviewServerFixture") {
  static readonly layer = Layer.effect(SlackReviewServerFixture, makeSlackReviewServerFixture());
}

const slackReviewServerTestLayer = () =>
  Layer.unwrap(
    Effect.map(SlackReviewServerFixture, ({ clientLayer, fetchStub, serverLayer }) =>
      Layer.merge(serverLayer, clientLayer).pipe(
        Layer.provide(NodeServices.layer),
        Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchStub)),
      ),
    ),
  ).pipe(Layer.provideMerge(SlackReviewServerFixture.layer), Layer.provideMerge(SlackReviewProbe.layer));

const advancingClock = () => {
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
        edits: [{ _tag: "Rename", name: "Edited" }],
      });
      const listed = yield* rpc.ListWorkflows();
      const fetched = yield* rpc.GetWorkflow({ id: created.id });
      const diagnostics = yield* rpc.ValidateWorkflow({ document: { name: "Malformed" } });
      const publish = yield* Effect.result(
        rpc.PublishWorkflow({ id: created.id, revision: edited.workingRevision }),
      );
      const switched = yield* Effect.result(rpc.SwitchWorkflow({ id: created.id, enabled: true }));
      const catalog = yield* rpc.GetWorkflowCatalog();
      const status = yield* rpc.GetStatus();
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
      assert.lengthOf(catalog.catalog.entries, 45);
      assert.isTrue(catalog.catalog.entries.some(({ key }) => key === "schedule.daily"));
      assert.isTrue(catalog.catalog.entries.some(({ key }) => key === "slack.i-am-mentioned"));
      assert.deepInclude(
        catalog.catalog.entries.find(({ key }) => key === "slack.send-message"),
        { parameters: [{ id: "channel", required: true, source: "live", values: [] }] },
      );
      assert.deepStrictEqual(
        status.sources.map(({ source }) => source),
        ["github", "linear", "clock", "granola", "slack"],
      );
      assert.isTrue(
        [...seed].some((event) => event._tag === "WorkflowChanged" && event.workflow.id === created.id),
      );
      assert.strictEqual(deleted, created.id);
    }).pipe(Effect.provide(githubServerTestLayer()), Effect.scoped),
  );

  it.effect("round-trips the Granola fan-out document through DaemonRpcs", () =>
    Effect.gen(function* () {
      yield* Daemon.bootstrap;
      const rpc = yield* RpcClient.make(DaemonRpcs);
      const document = yield* Schema.decodeEffect(WorkflowDocument)({
        name: "Granola commitments",
        workspaces: { _tag: "Every" },
        triggers: [
          {
            id: "note-generated",
            entry: "granola.note-generated",
            parameters: [],
            start: "route-commitments",
          },
        ],
        operations: [
          {
            id: "route-commitments",
            name: "Route commitments",
            instructionPackage: null,
            instruction: "Route each commitment to an issue.",
            permissionProfile: "read-only",
            requires: [],
            model: { harness: "cursor", model: "test", options: [] },
            forEach: "commitment",
            questions: [
              {
                id: "match",
                text: "Match?",
                choices: [
                  { id: "new", name: "New" },
                  { id: "duplicate", name: "Duplicate" },
                ],
              },
            ],
            transitions: [
              {
                when: [{ question: "match", choice: "new" }],
                actions: [{ entry: "github.create-issue", parameters: [] }],
                handOff: null,
              },
              {
                when: [{ question: "match", choice: "duplicate" }],
                actions: [{ entry: "github.comment-issue", parameters: [] }],
                handOff: null,
              },
            ],
            hints: [],
          },
        ],
      });

      const created = yield* rpc.CreateWorkflow({ document });
      const fetched = yield* rpc.GetWorkflow({ id: created.id });
      const deleted = yield* rpc.DeleteWorkflow({ id: created.id });

      assert.strictEqual(fetched.workingCopy.operations[0]?.forEach, "commitment");
      assert.deepStrictEqual(
        fetched.workingCopy.operations[0]?.transitions.flatMap(({ actions }) =>
          actions.map(({ entry }) => entry),
        ),
        ["github.create-issue", "github.comment-issue"],
      );
      assert.strictEqual(deleted, created.id);
    }).pipe(Effect.provide(githubServerTestLayer()), Effect.scoped),
  );

  it.effect("publishes both coding templates through DaemonRpcs", () =>
    Effect.gen(function* () {
      yield* Daemon.bootstrap;
      const rpc = yield* RpcClient.make(DaemonRpcs);
      const templates = (yield* rpc.GetWorkflowTemplates()).filter(({ id }) =>
        id.endsWith("-coding-pipeline"),
      );
      const created = yield* Effect.forEach(templates, ({ document }) => rpc.CreateWorkflow({ document }));
      const published = yield* Effect.forEach(created, ({ id, workingRevision }) =>
        rpc.PublishWorkflow({ id, revision: workingRevision }),
      );

      assert.deepStrictEqual(
        templates.map(({ id }) => id),
        ["github-coding-pipeline", "linear-coding-pipeline"],
      );
      const rejectedDiagnostics = created.flatMap(({ diagnostics }) =>
        diagnostics.filter(({ class: diagnosticClass, code }) => {
          const isBlocking = diagnosticClass === "malformed" || diagnosticClass === "incomplete";
          const isForbiddenAdvisory = ["hand-off-and-trigger", "unreachable-operation"].includes(code);
          return isBlocking || isForbiddenAdvisory;
        }),
      );
      assert.deepStrictEqual(rejectedDiagnostics, []);
      assert.lengthOf(published, 2);
    }).pipe(Effect.provide(githubServerTestLayer()), Effect.scoped),
  );

  it.effect("runs the Slack review template through the composed daemon", () =>
    Effect.gen(function* () {
      yield* Daemon.bootstrap;
      const rpc = yield* RpcClient.make(DaemonRpcs);
      const fixture = yield* SlackReviewServerFixture;
      const probe = yield* SlackReviewProbe;
      yield* rpc.SetOperationSetting({
        updates: [
          {
            _tag: "Set",
            row: {
              setting: "harness",
              level: { _tag: "Default" },
              scope: { _tag: "SettingsProfile" },
              value: "cursor",
            },
          },
        ],
      });
      yield* rpc.EstablishConnection({
        establishment: { system: "github", source: { _tag: "Env", name: "GITHUB_TOKEN" } },
      });
      yield* rpc.EstablishConnection({
        establishment: { system: "slack", account: "review-team", source: { _tag: "Stored" } },
      });
      const registration = yield* Schema.decodeEffect(WorkspaceRegistration)({
        name: "github",
        checkoutPath: fixture.root,
        issueTracker: { type: "github", connectionId: "github/connected-account" },
        sourceControl: { type: "github", connectionId: "github/connected-account" },
        linearHistory: false,
      });
      const workspace = yield* rpc.RegisterWorkspace({ registration });
      assert.strictEqual(workspace._tag, "Registered");
      if (workspace._tag !== "Registered") return;
      yield* Ref.set(probe.workspace, workspace.name);
      const template = (yield* rpc.GetWorkflowTemplates()).find(({ id }) => id === "slack-to-github-review");
      assert.isDefined(template);
      if (template === undefined) return;
      const created = yield* rpc.CreateWorkflow({ document: template.document });
      assert.deepStrictEqual(
        created.diagnostics.filter(({ class: diagnosticClass }) =>
          ["malformed", "incomplete"].includes(diagnosticClass),
        ),
        [],
      );
      yield* rpc.PublishWorkflow({ id: created.id, revision: created.workingRevision });
      const triggerObservation = yield* TriggerObservation;
      const changes = yield* Stream.toPull(triggerObservation.changes);
      const switched = yield* rpc.SwitchWorkflow({ id: created.id, enabled: true });
      assert.isTrue(switched.workflow.enabled);
      const admissions = yield* Stream.fromPull(Effect.succeed(changes)).pipe(
        Stream.take(3),
        Stream.runCollect,
      );
      assert.lengthOf(admissions, 3);
      assert.deepStrictEqual(
        [...admissions]
          .map(({ event }) => (event.key._tag === "SlackMessage" ? event.key.ts : ""))
          .toSorted(),
        Object.values(fixture.timestamps).toSorted(),
      );
      yield* rpc.SetScheduling({ desired: "running" });
      const scheduler = yield* Scheduler;
      const picked = yield* scheduler.tick();
      yield* scheduler.awaitIdle;
      assert.strictEqual(picked, 3);

      const attention = yield* rpc.ListWorkflowAttention();
      const awaitingApproval = attention.parks.find(
        ({ item, reason }) =>
          item._tag === "SlackMessage" &&
          item.ts === fixture.timestamps.approve &&
          reason._tag === "AwaitingApproval",
      );
      const handedToYou = attention.parks.find(
        ({ item, reason }) =>
          item._tag === "SlackMessage" &&
          item.ts === fixture.timestamps.cannotReview &&
          reason._tag === "HandedToYou",
      );
      assert.isDefined(handedToYou);
      assert.isDefined(awaitingApproval);
      assert.notInclude(
        attention.parks.map(({ item }) => (item._tag === "SlackMessage" ? item.ts : "")),
        fixture.timestamps.notActionable,
      );
      assert.deepStrictEqual(
        awaitingApproval?.plan?.steps.map(({ entry, status }) => [String(entry), status]),
        [
          ["cogwork.wait-for-approval", "pending"],
          ["github.post-review", "pending"],
          ["slack.reply-in-thread", "pending"],
        ],
      );
      const requests = () => fixture.fetchStub.mock.calls.map(([input, init]) => new Request(input, init));
      const slackWriteBodies = () =>
        Effect.forEach(
          requests().filter(
            (request) =>
              request.method === "POST" &&
              ["/api/reactions.add", "/api/chat.postMessage"].includes(new URL(request.url).pathname),
          ),
          (request) => Effect.promise(() => request.json()),
        );
      const writesBeforeApproval = yield* slackWriteBodies();
      assert.deepStrictEqual(
        writesBeforeApproval
          .map((body) => ({
            name: "name" in body ? body.name : "reply",
            timestamp: "timestamp" in body ? body.timestamp : body.thread_ts,
          }))
          .toSorted((left, right) => String(left.timestamp).localeCompare(String(right.timestamp))),
        [
          { name: "eyes", timestamp: fixture.timestamps.approve },
          { name: "reply", timestamp: fixture.timestamps.approve },
          { name: "eyes", timestamp: fixture.timestamps.cannotReview },
          { name: "reply", timestamp: fixture.timestamps.cannotReview },
        ],
      );
      assert.isFalse(
        requests().some(
          (request) =>
            request.method === "POST" &&
            new URL(request.url).pathname === "/repos/owner/repo/pulls/827/reviews",
        ),
      );
      assert.isDefined(awaitingApproval?.attempt);
      assert.strictEqual(awaitingApproval?.reason._tag, "AwaitingApproval");
      const cannotApprove =
        awaitingApproval?.attempt === null ||
        awaitingApproval?.attempt === undefined ||
        awaitingApproval.reason._tag !== "AwaitingApproval";
      if (cannotApprove) return;
      yield* rpc.ApproveWorkflowPlan({
        item: awaitingApproval.item,
        attempt: awaitingApproval.attempt,
        digest: awaitingApproval.reason.digest,
      });

      const reviewRequest = requests().find(
        (request) =>
          request.method === "POST" &&
          new URL(request.url).pathname === "/repos/owner/repo/pulls/827/reviews",
      );
      assert.isDefined(reviewRequest);
      const reviewBody = yield* Effect.promise(() => reviewRequest?.json() ?? Promise.resolve({}));
      assert.strictEqual(reviewBody.event, "APPROVE");
      assert.include(reviewBody.body, "Looks good.");
      const writesAfterApproval = yield* slackWriteBodies();
      const repliedAfterApproval = writesAfterApproval.some(
        (body) =>
          body.channel === "C-review" &&
          body.text === "Reviewed #827." &&
          body.thread_ts === fixture.timestamps.approve,
      );
      assert.isTrue(repliedAfterApproval);
      assert.deepStrictEqual(yield* Ref.get(probe.pullRequestToolCalls), [
        { workspace: workspace.name, pull_request: "#827" },
        { workspace: workspace.name, pull_request: "#827" },
      ]);
    }).pipe(
      Effect.provide(slackReviewServerTestLayer()),
      Effect.provideService(Clock.Clock, advancingClock()),
      Effect.scoped,
    ),
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
        result.workflowCatalog.catalog.entries.map(({ name }) => name),
        [
          "Notify me",
          "Wait for my approval",
          "Withdraw the pending approval",
          "Hand to me",
          "Stop",
          "Create an issue",
          "Comment on this item",
          "Comment on an existing issue",
          "Add a label",
          "Remove a label",
          "Close this issue",
          "Create an issue",
          "Comment on this item",
          "Comment on an existing issue",
          "Add a label",
          "Remove a label",
          "Close this issue",
          "Open a pull request",
          "Push to this pull request",
          "Comment on this pull request",
          "Request a review",
          "Comment on a named pull request",
          "Post a review",
          "Draft a review",
          "Issue has label",
          "New comment from a person",
          "Pull request checks failed",
          "Pull request conflicts with its base",
          "New review comment from a person",
          "New finding from a bot",
          "Issue has label",
          "New comment from a person",
          "Every hour",
          "Every day",
          "Every week",
          "Sweep idle items",
          "Note generated",
          "Note edited",
          "I am mentioned",
          "Message in a channel",
          "Reaction added",
          "Send a message",
          "Reply in thread",
          "Add a reaction",
          "Draft a reply in Slack",
        ],
      );
      assert.isTrue(Result.isFailure(result.readiness));
    }).pipe(Effect.provide(unavailableServerTestLayer()), Effect.scoped),
  );
});
