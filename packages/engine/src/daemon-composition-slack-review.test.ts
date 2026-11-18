import { DaemonRpcs, WorkspaceId, WorkspaceRegistration } from "@cogwork/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcServer from "effect/rpc/RpcServer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Socket from "effect/socket/Socket";
import { vi } from "vitest";
import * as CredentialStore from "./credential-store";
import * as Daemon from "./daemon";
import {
  advancingClock,
  contextAssemblerLayer,
  gitLayer,
  harnessName,
  resultEvent,
  runner,
  socketServerLayer,
  worktreeLayer,
} from "./daemon-composition-fixtures";
import type { HarnessRunner } from "./harness";
import { PerformanceHealthSource } from "./performance-health-source";
import * as RunLedger from "./run-ledger";
import { Scheduler } from "./scheduler";
import {
  makeMemoryTriggerObservationStore,
  TriggerObservation,
  TriggerObservationStore,
} from "./trigger-observation";

interface PullRequestToolCall {
  readonly workspace: WorkspaceId;
  readonly pull_request: string;
}

interface SlackReviewProbeService {
  readonly workspace: Ref.Ref<WorkspaceId>;
  readonly pullRequestToolCalls: Ref.Ref<ReadonlyArray<PullRequestToolCall>>;
}

class SlackReviewProbe extends Context.Service<SlackReviewProbe, SlackReviewProbeService>()(
  "@cogwork/engine/daemon-composition-slack-review.test/SlackReviewProbe",
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
>()("@cogwork/engine/daemon-composition-slack-review.test/SlackReviewServerFixture") {
  static readonly layer = Layer.effect(SlackReviewServerFixture, makeSlackReviewServerFixture());
}

const slackReviewServerTestLayer = () =>
  Layer.unwrap(
    Effect.map(SlackReviewServerFixture, ({ clientLayer, fetchStub, serverLayer }) =>
      Layer.merge(serverLayer, clientLayer).pipe(
        Layer.provide(
          Layer.mergeAll(NodeServices.layer, NodeCrypto.layerSecureRandom, NodeCrypto.layerDigest),
        ),
        Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchStub)),
      ),
    ),
  ).pipe(
    Layer.provideMerge(SlackReviewServerFixture.layer),
    Layer.provideMerge(SlackReviewProbe.layer),
    Layer.provide(NodeServices.layer),
  );

describe("daemon composition", () => {
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
