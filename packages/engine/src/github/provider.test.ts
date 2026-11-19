import { WorkflowActionOrigin, WorkspaceConfig } from "@cogwork/contracts";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type { RegisteredWorkspace } from "../projector";
import { readOnlyRegistry, WorkspaceRegistry } from "../registry-service";
import { SourceControlProvider } from "../source-control";
import { GitHubClient, type RawIssueComment } from "./client";
import { wireCodec } from "./markers";
import { layer } from "./provider";

const actor = "cogwork-bot";
const reviewer = "maintainer";
const summary = "Pushed the review fixes.";

const workspace: RegisteredWorkspace = {
  source: "control-store:cogwork",
  repository: "colonylabs/cogwork",
  contributions: [],
  config: Schema.decodeSync(WorkspaceConfig)({
    id: "cogwork",
    displayName: "cogwork",
    checkoutPath: "/repos/cogwork",
    issueTracker: { type: "github" },
  }),
};

const pullRequest = {
  number: 943,
  url: "https://github.com/colonylabs/cogwork/pull/943",
  headBranch: "903-follow-up",
  baseBranch: "main",
};

const origin = (writeKey: string) =>
  Schema.decodeSync(WorkflowActionOrigin)({
    item: "pull-request:cogwork:943",
    workflow: "follow-up",
    attempt: "run-1",
    writeKey,
    lineage: { root: "pull-request:cogwork:943", parent: null, hop: 0 },
  });

const visibleText = (body: string) =>
  wireCodec
    .scan(body)
    .reduceRight((text, { start, end }) => text.slice(0, start) + text.slice(end), body)
    .trim();

class GitHubWriteProbe extends Context.Service<
  GitHubWriteProbe,
  {
    readonly comments: Ref.Ref<ReadonlyArray<RawIssueComment>>;
    readonly requested: Ref.Ref<Array<string>>;
  }
>()("@cogwork/engine/github/provider.test/GitHubWriteProbe") {
  static readonly layer = Layer.effect(
    GitHubWriteProbe,
    Effect.all({
      comments: Ref.make<ReadonlyArray<RawIssueComment>>([]),
      requested: Ref.make<Array<string>>([]),
    }),
  );
}

const clientLayer = Layer.unwrap(
  Effect.map(GitHubWriteProbe, ({ comments, requested }) =>
    Layer.mock(GitHubClient, {
      authenticatedLogin: () => Effect.succeed(actor),
      listAllComments: () => Ref.get(comments),
      createComment: (_target, _number, body) =>
        Ref.update(comments, (current) => [
          ...current,
          { id: current.length, authorLogin: actor, authorAssociation: "OWNER", body, createdAtMillis: 0 },
        ]),
      listRequestedReviewers: () => Ref.get(requested),
      requestReview: (_target, _number, login) => Ref.update(requested, (current) => [...current, login]),
    }),
  ),
);

const providerLayer = layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      clientLayer,
      Layer.succeed(WorkspaceRegistry, readOnlyRegistry({ workspaces: [workspace], failures: [] })),
    ),
  ),
  Layer.provideMerge(GitHubWriteProbe.layer),
);

it.effect(
  "a pushing follow-up round writes one visible comment and one review request, even when repeated",
  () =>
    Effect.gen(function* () {
      const provider = yield* SourceControlProvider;
      const probe = yield* GitHubWriteProbe;

      yield* Effect.forEach(["first", "repeat"], () =>
        Effect.all(
          [
            provider.recordPullRequestPush(workspace, pullRequest, origin("write-0")),
            provider.requestReview(workspace, pullRequest, reviewer, origin("write-1")),
            provider.commentPullRequest(workspace, pullRequest, summary, origin("write-2")),
          ],
          { discard: true },
        ),
      );

      assert.deepStrictEqual(
        (yield* Ref.get(probe.comments)).map(({ body }) => visibleText(body)),
        [summary],
      );
      assert.deepStrictEqual(yield* Ref.get(probe.requested), [reviewer]);
    }).pipe(Effect.provide(providerLayer)),
);
