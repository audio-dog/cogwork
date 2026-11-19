import { WorkspaceId } from "@cogwork/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type * as Clock from "effect/Clock";
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
import * as Stream from "effect/Stream";
import * as Socket from "effect/socket/Socket";
import { vi } from "vitest";
import * as CredentialStore from "./credential-store";
import * as Daemon from "./daemon";
import {
  contextAssemblerLayer,
  gitLayer,
  resultEvent,
  runner,
  socketServerLayer,
  worktreeLayer,
} from "./daemon-composition-fixtures";
import type { HarnessRunner } from "./harness";
import { PerformanceHealthSource } from "./performance-health-source";
import * as RunLedger from "./run-ledger";
import { makeMemoryTriggerObservationStore, TriggerObservationStore } from "./trigger-observation";

interface PullRequestToolCall {
  readonly workspace: WorkspaceId;
  readonly pull_request: string;
}

interface SlackReviewProbeService {
  readonly workspace: Ref.Ref<WorkspaceId>;
  readonly pullRequestToolCalls: Ref.Ref<ReadonlyArray<PullRequestToolCall>>;
}

export class SlackReviewProbe extends Context.Service<SlackReviewProbe, SlackReviewProbeService>()(
  "@cogwork/engine/daemon-composition-slack-review-fixtures/SlackReviewProbe",
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

export class SlackReviewServerFixture extends Context.Service<
  SlackReviewServerFixture,
  Effect.Success<ReturnType<typeof makeSlackReviewServerFixture>>
>()("@cogwork/engine/daemon-composition-slack-review-fixtures/SlackReviewServerFixture") {
  static readonly layer = Layer.effect(SlackReviewServerFixture, makeSlackReviewServerFixture());
}

export const slackReviewServerTestLayer = () =>
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
