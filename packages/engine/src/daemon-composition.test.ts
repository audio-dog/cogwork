import {
  connectionIdOf,
  DaemonRpcs,
  HarnessName,
  IssueTrackerType,
  keyOf,
  LineageId,
  RunId,
  type RunRecord,
  SourceControlType,
  WorkItemId,
  WorkspaceId,
  WorkspaceRegistration,
} from "@cogwork/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import * as Socket from "effect/unstable/socket/Socket";
import * as SocketServer from "effect/unstable/socket/SocketServer";
import { vi } from "vitest";
import * as ContextAssembler from "./context-assembler";
import { Coordination } from "./coordination";
import * as CredentialStore from "./credential-store";
import * as Daemon from "./daemon";
import { Git, type GitService } from "./git";
import { fullHarnessExecution, type HarnessRunner } from "./harness";
import { PerformanceHealthSource } from "./performance-health-source";
import * as RunLedger from "./run-ledger";
import { Scheduler } from "./scheduler";
import {
  makeMemoryTriggerObservationStore,
  TriggerObservation,
  TriggerObservationStore,
} from "./trigger-observation";
import { WorktreeManager, type WorktreeManagerService } from "./worktree";

const harnessName = HarnessName.make("scripted");
const githubType = Schema.decodeSync(IssueTrackerType)("github");
const githubSourceControl = Schema.decodeSync(SourceControlType)("github");
const structuredOutput = {
  summary: "Ready for implementation",
  stuck: false,
  answers: { role: "ready-for-agent" },
  inputs: { comment: "Ready for implementation.", hand_off: "" },
};

const resultEvent = (object: unknown) => ({
  type: "CUSTOM" as const,
  name: "structured-output.complete" as const,
  value: { object, raw: JSON.stringify(object) },
});

const runner: HarnessRunner = {
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

const reconcileWorktrees = vi.fn<WorktreeManagerService["reconcile"]>(() =>
  Effect.succeed({ tornDown: [], reaped: [] }),
);

const worktreeLayer = Layer.succeed(WorktreeManager, {
  withRunOwnershipLock: (effect) => effect,
  tryWithMaintenanceLock: Effect.asSome,
  ensure: () => Effect.die("unused"),
  pullRequestReadiness: () => Effect.die("unused"),
  pushBranch: () => Effect.die("unused"),
  pushBranchIfAhead: () => Effect.die("unused"),
  list: () => Effect.succeed([]),
  remove: () => Effect.void,
  reconcile: reconcileWorktrees,
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

const contextAssemblerLayer = Layer.succeed(ContextAssembler.ContextAssembler, {
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

const socketServerLayer = (socket: Socket.Socket) =>
  Layer.succeed(SocketServer.SocketServer, {
    address: { _tag: "UnixAddress", path: "memory" },
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

const jsonResponse = (body: unknown = {}, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

interface PullRequestToolCall {
  readonly workspace: WorkspaceId;
  readonly pull_request: string;
}

interface SlackReviewProbeService {
  readonly workspace: Ref.Ref<WorkspaceId>;
  readonly pullRequestToolCalls: Ref.Ref<ReadonlyArray<PullRequestToolCall>>;
}

class SlackReviewProbe extends Context.Service<SlackReviewProbe, SlackReviewProbeService>()(
  "@cogwork/engine/daemon-composition.test/SlackReviewProbe",
) {
  static readonly layer = Layer.effect(
    SlackReviewProbe,
    Effect.all({
      workspace: Ref.make(WorkspaceId.make("none")),
      pullRequestToolCalls: Ref.make<ReadonlyArray<PullRequestToolCall>>([]),
    }),
  );
}

const slackReviewRunner = (probe: SlackReviewProbeService): HarnessRunner => ({
  ...runner,
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
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-slack-review-" });
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
        controlStorePath: path.join(root, "control.db"),
        userAgentsDir: path.join(root, ".agents"),
        worktrees: worktreeLayer,
        harnessRunners: [slackReviewRunner(probe)],
        appVersion: "test",
        performanceEvidenceRoot: path.join(root, "perf"),
        performanceHealth: Layer.succeed(PerformanceHealthSource, {
          snapshot: Effect.succeed({ sampledAtMillis: 0 }),
        }),
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
  ).pipe(
    Layer.provideMerge(SlackReviewServerFixture.layer),
    Layer.provideMerge(SlackReviewProbe.layer),
    Layer.provide(NodeServices.layer),
  );

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

class Fixture extends Context.Service<Fixture, Effect.Success<ReturnType<typeof makeFixture>>>()(
  "@cogwork/engine/daemon-composition.test/Fixture",
) {
  static readonly layer = Layer.effect(Fixture, makeFixture());
}

const testLayer = () =>
  Layer.unwrap(
    Effect.map(Fixture, ({ clientLayer, fetchStub, serverLayer }) =>
      Layer.merge(serverLayer, clientLayer).pipe(
        Layer.provide(NodeServices.layer),
        Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchStub)),
      ),
    ),
  ).pipe(Layer.provideMerge(Fixture.layer), Layer.provide(NodeServices.layer));

const crashedIssue = {
  _tag: "Issue",
  workspace: WorkspaceId.make("github"),
  id: WorkItemId.make("#1"),
} as const;

const claimCrashedIssue = Effect.fn("DaemonCompositionTest.claimCrashedIssue")(function* () {
  const coordination = yield* Coordination;
  yield* coordination.observe(crashedIssue, "label:needs-triage:1", { _tag: "Unknown" });
  yield* coordination.claim(crashedIssue, {
    operation: { workflow: "coding", operation: "triage" },
    lineage: { root: LineageId.make(keyOf(crashedIssue)), parent: null, hop: 0 },
  });
  yield* TestClock.adjust("1 minute");
});

const issueRun = (id: string, status: RunRecord["status"], startedAtMillis: number) =>
  ({
    id: RunId.make(id),
    workspace: crashedIssue.workspace,
    workItem: WorkItemId.make(keyOf(crashedIssue)),
    operation: "triage",
    harness: harnessName,
    branch: null,
    session: null,
    usage: null,
    status,
    startedAtMillis,
    endedAtMillis: status === "running" ? null : startedAtMillis,
  }) satisfies RunRecord;

const startHeartbeats = Effect.fn("DaemonCompositionTest.startHeartbeats")(function* () {
  yield* Effect.forkScoped(
    Daemon.heartbeats({ pollIntervalMillis: 60_000, drain: { graceMillis: 0, abort: Effect.never } }),
  );
  yield* TestClock.adjust("1 second");
});

describe("daemon composition", () => {
  it.effect("creates, publishes, and enables the coding template before triaging through the daemon", () =>
    Effect.gen(function* () {
      const fixture = yield* Fixture;
      const rpc = yield* RpcClient.make(DaemonRpcs);
      assert.deepStrictEqual((yield* rpc.ListWorkflows()).workflows, []);
      yield* rpc.EstablishConnection({
        establishment: { system: "github", source: { _tag: "Stored" } },
      });
      const registration = yield* rpc.RegisterWorkspace({
        registration: {
          name: WorkspaceId.make("github"),
          checkoutPath: fixture.checkoutPath,
          issueTracker: { type: githubType, connectionId: connectionIdOf("github", "owner") },
          linearHistory: false,
        },
      });
      assert.strictEqual(registration._tag, "Registered");
      if (registration._tag !== "Registered") return;
      yield* rpc.SetOperationSetting({
        updates: [
          {
            _tag: "Set",
            row: {
              setting: "harness",
              level: { _tag: "Default" },
              scope: { _tag: "SettingsProfile" },
              value: harnessName,
            },
          },
        ],
      });
      const templates = yield* rpc.GetWorkflowTemplates();
      assert.includeMembers(
        templates.map(({ id }) => id),
        ["github-coding-pipeline", "linear-coding-pipeline"],
      );
      const template = templates.find(({ id }) => id === "github-coding-pipeline");
      if (!template) return assert.fail("GitHub coding template is missing");
      const created = yield* rpc.CreateWorkflow({ document: template.document });
      const published = yield* rpc.PublishWorkflow({ id: created.id, revision: created.workingRevision });
      yield* rpc.SwitchWorkflow({ id: published.id, enabled: true });
      yield* TestClock.adjust("1 minute");
      const eligible = yield* (yield* TriggerObservation).eligible;
      assert.deepStrictEqual(
        eligible.map(({ event }) => event.key),
        [{ _tag: "Issue", workspace: registration.name, id: WorkItemId.make("#1") }],
      );
      yield* rpc.SetScheduling({ desired: "running" });
      const scheduler = yield* Scheduler;
      assert.strictEqual(yield* scheduler.tick(), 1);
      yield* scheduler.awaitIdle;

      const labelWrite = fixture.fetchStub.mock.calls.some(([input, init]) => {
        const request = new Request(input, init);
        return request.method === "POST" && request.url.endsWith("/issues/1/labels");
      });
      assert.isTrue(labelWrite);
    }).pipe(Effect.provide(testLayer()), Effect.scoped),
  );

  it.effect("marks a Run the stopped daemon left running as crashed and releases its Claim", () =>
    Effect.gen(function* () {
      const ledger = yield* RunLedger.RunLedger;
      const coordination = yield* Coordination;
      yield* claimCrashedIssue();
      yield* ledger.insertRun(issueRun("left-running", "running", 1));

      yield* startHeartbeats();

      assert.strictEqual((yield* ledger.getRun(RunId.make("left-running")))?.status, "crashed");
      const view = yield* coordination.read(crashedIssue);
      assert.isNull(view.claim);
      assert.isNull(view.park);
    }).pipe(Effect.provide(testLayer()), Effect.scoped),
  );

  it.effect("parks an item exhausted after its third Run in a row dies with the daemon", () =>
    Effect.gen(function* () {
      const ledger = yield* RunLedger.RunLedger;
      yield* claimCrashedIssue();
      yield* ledger.insertRun(issueRun("first-crash", "crashed", 1));
      yield* ledger.insertRun(issueRun("second-crash", "crashed", 2));
      yield* ledger.insertRun(issueRun("left-running", "running", 3));

      yield* startHeartbeats();

      const view = yield* (yield* Coordination).read(crashedIssue);
      assert.strictEqual(view.park?.reason._tag, "Exhausted");
    }).pipe(Effect.provide(testLayer()), Effect.scoped),
  );

  it.effect("maintains worktrees and reads pull requests once per poll interval", () =>
    Effect.gen(function* () {
      const fixture = yield* Fixture;
      const rpc = yield* RpcClient.make(DaemonRpcs);
      reconcileWorktrees.mockClear();
      yield* rpc.EstablishConnection({ establishment: { system: "github", source: { _tag: "Stored" } } });
      const connectionId = connectionIdOf("github", "owner");
      const registration = yield* rpc.RegisterWorkspace({
        registration: {
          name: WorkspaceId.make("github"),
          checkoutPath: fixture.checkoutPath,
          issueTracker: { type: githubType, connectionId },
          sourceControl: { type: githubSourceControl, connectionId },
          worktrees: { reapAfterMillis: 1 },
          linearHistory: false,
        },
      });
      if (registration._tag !== "Registered") return assert.fail("Workspace registration failed");
      const pullListReads = () =>
        fixture.fetchStub.mock.calls.filter(([input, init]) => {
          const request = new Request(input, init);
          return request.method === "GET" && new URL(request.url).pathname.endsWith("/pulls");
        }).length;
      const readsBeforeHeartbeats = pullListReads();

      yield* startHeartbeats();
      yield* TestClock.adjust("50 seconds");

      assert.deepStrictEqual(
        reconcileWorktrees.mock.calls.map(([workspace]) => workspace.config.name),
        [registration.name],
      );
      const heartbeatReads = pullListReads() - readsBeforeHeartbeats;
      assert.isAbove(heartbeatReads, 0);
      assert.isAtMost(heartbeatReads, 2);
    }).pipe(Effect.provide(testLayer()), Effect.scoped),
  );

  it.effect("runs the Slack review template through the composed daemon", () =>
    Effect.gen(function* () {
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
              value: harnessName,
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
});
