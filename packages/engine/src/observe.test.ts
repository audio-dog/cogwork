import { codingOperation, LineageId, WorkItemId, WorkspaceConfig } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { classify } from "./classify";
import type { FollowUpMarker } from "./follow-up";
import type { IssueTrackerService, TrackerItem } from "./issue-tracker";
import { observeWorkspace } from "./observe";
import type { RegisteredWorkspace } from "./projector";
import type { PrSignals, SourceControlProviderService } from "./source-control";

const id = Schema.decodeSync(WorkItemId);
const lineage = { root: LineageId.make("issue:7"), parent: null, hop: 0 };
const attempt = (
  stage: "implement" | "follow-up",
  outcome: "succeeded" | "failed" | "abandoned",
  atMillis: number,
) => ({ operation: codingOperation(stage), outcome, atMillis, lineage });

const workspace: RegisteredWorkspace = {
  source: "fake.workspace.ts",
  contributions: [],
  config: Schema.decodeSync(WorkspaceConfig)({
    name: "fake",
    checkoutPath: "/repos/fake",
    issueTracker: { type: "github" },
  }),
};

const followUp: FollowUpMarker = {
  checks: "failing",
  humanCommentAtMillis: 0,
  noProgress: 3,
  baseDivergence: "none",
  botTriggerAtMillis: 0,
};

const item = (attempts: TrackerItem["attempts"]): TrackerItem => ({
  id: id("#7"),
  title: "retry me",
  url: "https://github.com/owner/repo/issues/7",
  roles: ["ready-for-agent"],
  assignees: [],
  claimHeld: false,
  claim: null,
  claimedByUs: false,
  attempts,
  handback: { by: "local-owner", atMillis: 5 },
  followUp,
  openBlockers: 0,
  proposal: null,
  priority: "medium",
});

const tracker = (tracked: TrackerItem): IssueTrackerService => ({
  rateLimitScope: () => null,
  observe: () => Effect.succeed([tracked]),
  readProse: () => Effect.succeed({ body: "", comments: [] }),
  claim: () => Effect.void,
  release: () => Effect.void,
  note: () => Effect.void,
  triaged: () => Effect.void,
  implemented: () => Effect.void,
  followedUp: () => Effect.void,
  attemptFailed: () => Effect.void,
  handOff: () => Effect.void,
  handBack: () => Effect.void,
  stalled: () => Effect.void,
  reclassify: () => Effect.void,
});

const provider = (signals: PrSignals): SourceControlProviderService => ({
  observe: () => Effect.succeed(new Map([[id("#7"), signals]])),
  comment: () => Effect.void,
  findOpenPullRequest: () => Effect.succeed(null),
  openPullRequest: () => Effect.succeed({ number: 1, url: "https://example.test/pull/1" }),
});

const pr: PrSignals = {
  number: 17,
  url: "https://github.com/owner/repo/pull/17",
  review: "changes-requested",
  checks: "failing",
  latestHumanCommentAtMillis: null,
  latestBotTriggerAtMillis: null,
  fresh: false,
  baseDivergence: "none",
  waitingSinceMillis: 1,
  headRef: "7-retry-me",
  followable: true,
  draft: false,
};

describe("observeWorkspace handback barrier", () => {
  it.effect("keeps post-handback history when the current Operation changes", () =>
    Effect.gen(function* () {
      const observed = yield* observeWorkspace(
        tracker(
          item([
            attempt("implement", "failed", 1),
            attempt("implement", "failed", 3),
            attempt("implement", "failed", 4),
            attempt("implement", "failed", 6),
          ]),
        ),
        provider(pr),
      )(workspace);

      assert.strictEqual(
        observed[0]?.coordination?.counters(codingOperation("implement")).consecutiveFailures,
        1,
      );
      assert.deepStrictEqual(
        classify(observed).eligible.map((work) => work.id),
        [id("#7")],
      );
    }),
  );

  it.effect("moves the barrier forward when a newer handback exists", () =>
    Effect.gen(function* () {
      const observed = yield* observeWorkspace(
        tracker({
          ...item([
            attempt("implement", "failed", 1),
            attempt("implement", "failed", 6),
            attempt("implement", "failed", 7),
            attempt("implement", "failed", 9),
          ]),
          handback: { by: "local-owner", atMillis: 8 },
        }),
        provider(pr),
      )(workspace);

      assert.strictEqual(
        observed[0]?.coordination?.counters(codingOperation("implement")).consecutiveFailures,
        1,
      );
    }),
  );

  it.effect("zeros no progress until a follow-up marker write happens after the handback", () =>
    Effect.gen(function* () {
      const beforeWrite = yield* observeWorkspace(
        tracker(item([attempt("follow-up", "succeeded", 4)])),
        provider(pr),
      )(workspace);
      const afterWrite = yield* observeWorkspace(
        tracker(item([attempt("follow-up", "abandoned", 6)])),
        provider(pr),
      )(workspace);
      const afterOtherOperation = yield* observeWorkspace(
        tracker(item([attempt("implement", "succeeded", 6)])),
        provider(pr),
      )(workspace);

      assert.strictEqual(beforeWrite[0]?.pr?.followUp?.noProgress, 0);
      assert.strictEqual(afterWrite[0]?.pr?.followUp?.noProgress, 3);
      assert.strictEqual(afterOtherOperation[0]?.pr?.followUp?.noProgress, 0);
    }),
  );
});
