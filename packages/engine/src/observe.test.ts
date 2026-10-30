import { codingOperation, LineageId, WorkItemId, WorkspaceConfig } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { classify } from "./classify";
import type { FollowUpMarker } from "./follow-up";
import { type IssueTrackerService, type TrackerItem, unsupportedWorkflowActions } from "./issue-tracker";
import { observeWorkspace } from "./observe";
import type { RegisteredWorkspace } from "./projector";
import {
  emptyService as emptySourceControl,
  type PrSignals,
  type SourceControlProviderService,
} from "./source-control";

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
  latestFailingCheckAtMillis: 3,
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

const tracker = (
  tracked: TrackerItem,
  handBack: IssueTrackerService["handBack"] = () => Effect.void,
): IssueTrackerService => ({
  ...unsupportedWorkflowActions,
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
  handBack,
  stalled: () => Effect.void,
  reclassify: () => Effect.void,
});

const provider = (signals: PrSignals): SourceControlProviderService => ({
  ...emptySourceControl,
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
  it.effect("clears an engine follow-up park before classifying newer human feedback", () =>
    Effect.gen(function* () {
      const handbacks = yield* Ref.make<ReadonlyArray<Parameters<IssueTrackerService["handBack"]>[2]>>([]);
      const attempts = [1, 2, 3].map((atMillis) => attempt("follow-up", "failed", atMillis));
      const observed = yield* observeWorkspace(
        tracker(
          {
            ...item(attempts),
            roles: ["ready-for-human"],
            handback: null,
            engineHandoffAtMillis: 5,
            followUp: { ...followUp, attemptAtMillis: 3 },
          },
          (_workspace, _id, outcome) => Ref.update(handbacks, (all) => [...all, outcome]),
        ),
        provider({ ...pr, latestHumanCommentAtMillis: 4, observedAtMillis: 6 }),
      )(workspace);

      assert.deepStrictEqual(yield* Ref.get(handbacks), [
        {
          record: { by: "cogwork", atMillis: 6 },
          changes: { remove: ["ready-for-human"], add: ["ready-for-agent"] },
          trigger: { kind: "human-feedback", atMillis: 4 },
        },
      ]);
      assert.deepStrictEqual(observed[0]?.roles, ["ready-for-agent"]);
      assert.strictEqual(classify(observed).eligible[0]?.priorFailures, 0);
      assert.deepStrictEqual(classify(observed).eligible[0]?.workContext.facts.followUpTrigger, {
        kind: "human-feedback",
        atMillis: 4,
      });
    }),
  );

  it.effect.each([
    {
      kind: "failing-check" as const,
      signals: { latestFailingCheckAtMillis: 4 },
    },
    {
      kind: "trusted-bot-finding" as const,
      signals: { latestBotTriggerAtMillis: 4 },
    },
    {
      kind: "merge-conflict" as const,
      signals: { baseDivergence: "conflict" as const },
    },
  ])("resets stale no progress when a $kind clears the park", ({ kind, signals }) =>
    Effect.gen(function* () {
      const attempts = [1, 2, 3].map((atMillis) => attempt("follow-up", "failed", atMillis));
      const observed = yield* observeWorkspace(
        tracker({
          ...item(attempts),
          roles: ["ready-for-human"],
          handback: null,
          engineHandoffAtMillis: 5,
          followUp: { ...followUp, attemptAtMillis: 3 },
        }),
        provider({ ...pr, observedAtMillis: 6, ...signals }),
      )(workspace);
      const eligible = classify(observed).eligible[0];

      assert.strictEqual(eligible?.stage, "follow-up");
      assert.strictEqual(eligible?.followUp?.noProgress, 1);
      assert.strictEqual(eligible?.workContext.facts.followUpTrigger?.kind, kind);
    }),
  );

  it.effect.each([
    { name: "draft pull request", signals: { draft: true } },
    { name: "unfollowable pull request", signals: { followable: false } },
  ])("keeps an engine follow-up park for a $name", ({ signals }) =>
    Effect.gen(function* () {
      const handbacks = yield* Ref.make<ReadonlyArray<Parameters<IssueTrackerService["handBack"]>[2]>>([]);
      const attempts = [1, 2, 3].map((atMillis) => attempt("follow-up", "failed", atMillis));
      const observed = yield* observeWorkspace(
        tracker(
          {
            ...item(attempts),
            roles: ["ready-for-human"],
            handback: null,
            engineHandoffAtMillis: 5,
            followUp: { ...followUp, attemptAtMillis: 3 },
          },
          (_workspace, _id, outcome) => Ref.update(handbacks, (all) => [...all, outcome]),
        ),
        provider({ ...pr, latestHumanCommentAtMillis: 4, observedAtMillis: 6, ...signals }),
      )(workspace);

      assert.isEmpty(yield* Ref.get(handbacks));
      assert.deepStrictEqual(observed[0]?.roles, ["ready-for-human"]);
    }),
  );

  it.effect("keeps a persisted wake trigger in work context on the next observation", () =>
    Effect.gen(function* () {
      const attempts = [1, 2, 3].map((atMillis) => attempt("follow-up", "failed", atMillis));
      const observed = yield* observeWorkspace(
        tracker({
          ...item(attempts),
          roles: ["ready-for-agent"],
          handback: { by: "cogwork", atMillis: 6 },
          followUpTrigger: { kind: "human-feedback", atMillis: 4 },
          followUp: { ...followUp, attemptAtMillis: 3 },
        }),
        provider({ ...pr, latestHumanCommentAtMillis: 4, observedAtMillis: 7 }),
      )(workspace);

      assert.deepStrictEqual(classify(observed).eligible[0]?.workContext.facts.followUpTrigger, {
        kind: "human-feedback",
        atMillis: 4,
      });
    }),
  );

  it.effect("does not use an external trigger timestamp as the failure barrier", () =>
    Effect.gen(function* () {
      const handbacks = yield* Ref.make<ReadonlyArray<Parameters<IssueTrackerService["handBack"]>[2]>>([]);
      const attempts = [1, 2, 3].map((atMillis) => attempt("follow-up", "failed", atMillis));
      yield* observeWorkspace(
        tracker(
          {
            ...item(attempts),
            roles: ["ready-for-human"],
            handback: null,
            engineHandoffAtMillis: 5,
            followUp: { ...followUp, attemptAtMillis: 3 },
          },
          (_workspace, _id, outcome) => Ref.update(handbacks, (all) => [...all, outcome]),
        ),
        provider({ ...pr, latestFailingCheckAtMillis: 4_102_444_800_000, observedAtMillis: 6 }),
      )(workspace);

      assert.strictEqual((yield* Ref.get(handbacks))[0]?.record.atMillis, 6);
    }),
  );

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
