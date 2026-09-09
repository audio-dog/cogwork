import {
  type BlockedItem,
  type Claim,
  type ClaimedItem,
  type NeedsHumanItem,
  PrSummary,
  type ReadyToMergeItem,
  SessionId,
  WorkItemId,
  WorkspaceConfig,
  WorkspaceId,
} from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import type { EligibleWork } from "./classify";
import type { RegisteredWorkspace } from "./projector";
import { classifiedItemsOf, schedulerStatsOf, workspaceInfoOf } from "./read-model";
import type { WorkspaceReconcileState } from "./reconcile";
import { initialState } from "./scheduler";

const id = Schema.decodeSync(WorkItemId);
const workspaceId = Schema.decodeSync(WorkspaceId);
const session = Schema.decodeSync(SessionId)("sess-1");

const prSummary = Schema.decodeSync(PrSummary)({
  number: 7,
  url: "https://github.com/owner/repo/pull/7",
  checks: "passing",
  review: "ready",
  baseDivergence: "none",
  waitingSinceMillis: 0,
});

const claim: Claim = { by: "cogwork", claimedAtMillis: 1000 };

const eligibleWithPr: EligibleWork = {
  id: id("e-pr"),
  title: "eligible with pr",
  url: "https://github.com/owner/repo/issues/e-pr",
  stage: "follow-up",
  priority: "medium",
  priorFailures: 2,
  followUp: {
    checks: "failing",
    humanCommentAtMillis: 0,
    botTriggerAtMillis: 0,
    noProgress: 1,
    stalled: false,
    fresh: false,
    baseDivergence: "none",
  },
  resume: { session, reason: "interrupted" },
  pr: prSummary,
  workContext: {
    reference: { workItem: id("e-pr"), url: "https://github.com/owner/repo/issues/e-pr" },
    facts: { roles: [], assignees: [], openBlockers: 0, claim: null, priority: "medium", pr: prSummary },
  },
};
const eligibleNoPr: EligibleWork = {
  id: id("e"),
  title: "eligible",
  url: null,
  stage: "implement",
  priority: "medium",
  priorFailures: 0,
  workContext: {
    reference: { workItem: id("e"), url: null },
    facts: { roles: [], assignees: [], openBlockers: 0, claim: null, priority: "medium", pr: null },
  },
};

const claimedWithPr: ClaimedItem = {
  id: id("c-pr"),
  title: "claimed with pr",
  url: "https://github.com/owner/repo/issues/c-pr",
  claim,
  pr: prSummary,
};
const claimedNoPr: ClaimedItem = { id: id("c"), title: "claimed", url: null, claim };

const blockedWithPr: BlockedItem = {
  id: id("b-pr"),
  title: "blocked with pr",
  url: "https://github.com/owner/repo/issues/b-pr",
  openBlockers: 2,
  pr: prSummary,
};
const blockedNoPr: BlockedItem = { id: id("b"), title: "blocked", url: null, openBlockers: 1 };

const needsHumanWithPr: NeedsHumanItem = {
  id: id("h-pr"),
  title: "needs-human with pr",
  reason: "ready-for-human",
  proposal: null,
  url: "https://github.com/owner/repo/issues/71",
  pr: prSummary,
};
const needsHumanNoPr: NeedsHumanItem = {
  id: id("h"),
  title: "needs-human",
  reason: "needs-info",
  proposal: null,
  url: "https://github.com/owner/repo/issues/72",
};

const readyToMerge: ReadyToMergeItem = {
  id: id("ready"),
  title: "ready to merge",
  url: "https://github.com/owner/repo/issues/73",
  pr: prSummary,
};

const state: WorkspaceReconcileState = {
  name: workspaceId("example"),
  poll: { status: "ok" },
  eligible: [eligibleWithPr, eligibleNoPr],
  claimed: [claimedWithPr, claimedNoPr],
  blocked: [blockedWithPr, blockedNoPr],
  needsHuman: [needsHumanWithPr, needsHumanNoPr],
  readyToMerge: [readyToMerge],
  observed: [],
  observedCount: 0,
  availability: [
    {
      operation: "implement",
      available: false,
      causes: [
        {
          _tag: "UnsatisfiedNeed",
          need: "review",
          kind: "skill",
          reason: "unbound",
          contribution: null,
          message: "review is unbound",
        },
      ],
    },
  ],
};

const workspace: RegisteredWorkspace = {
  source: "example.workspace.ts",
  contributions: [],
  config: Schema.decodeSync(WorkspaceConfig)({
    name: "example",
    checkoutPath: "/repos/example",
    issueTracker: { type: "github", repo: "owner/example" },
  }),
};

describe("classifiedItemsOf", () => {
  it("tags every bucket and carries the PR summary the classification attached", () => {
    const byId = new Map(classifiedItemsOf(state).map((item) => [item.id, item]));

    assert.deepStrictEqual(byId.get(id("e-pr")), {
      _tag: "Eligible",
      id: id("e-pr"),
      title: "eligible with pr",
      url: "https://github.com/owner/repo/issues/e-pr",
      stage: "follow-up",
      pr: prSummary,
    });
    assert.deepStrictEqual(byId.get(id("c-pr")), { _tag: "Claimed", ...claimedWithPr });
    assert.deepStrictEqual(byId.get(id("b-pr")), { _tag: "Blocked", ...blockedWithPr });
    assert.deepStrictEqual(byId.get(id("h-pr")), { _tag: "NeedsHuman", ...needsHumanWithPr });
    assert.deepStrictEqual(byId.get(id("ready")), { _tag: "ReadyToMerge", ...readyToMerge });
  });

  it("omits the PR key on every bucket without one, and never leaks scheduling-only fields", () => {
    const byId = new Map(classifiedItemsOf(state).map((item) => [item.id, item]));

    assert.deepStrictEqual(byId.get(id("e")), {
      _tag: "Eligible",
      id: id("e"),
      title: "eligible",
      url: null,
      stage: "implement",
    });
    assert.deepStrictEqual(byId.get(id("c")), { _tag: "Claimed", ...claimedNoPr });
    assert.deepStrictEqual(byId.get(id("b")), { _tag: "Blocked", ...blockedNoPr });
    assert.deepStrictEqual(byId.get(id("h")), { _tag: "NeedsHuman", ...needsHumanNoPr });
  });
});

describe("workspaceInfoOf", () => {
  it("projects current Operation availability", () => {
    const info = workspaceInfoOf(workspace, state);

    assert.deepStrictEqual(info.availability, state.availability);
  });

  it("projects the same five buckets and PR summaries as the event stream", () => {
    const info = workspaceInfoOf(workspace, state);

    assert.deepStrictEqual(info.eligible, [
      {
        id: id("e-pr"),
        title: "eligible with pr",
        url: "https://github.com/owner/repo/issues/e-pr",
        stage: "follow-up",
        pr: prSummary,
      },
      { id: id("e"), title: "eligible", url: null, stage: "implement" },
    ]);
    assert.deepStrictEqual(info.claimed, [claimedWithPr, claimedNoPr]);
    assert.deepStrictEqual(info.blocked, [blockedWithPr, blockedNoPr]);
    assert.deepStrictEqual(info.needsHuman, [needsHumanWithPr, needsHumanNoPr]);
    assert.deepStrictEqual(info.readyToMerge, [readyToMerge]);
  });

  it("reports an empty workspace whose poll is pending when it has no reconcile state yet", () => {
    const info = workspaceInfoOf(workspace, undefined);

    assert.deepStrictEqual(info.poll, { status: "pending" });
    assert.deepStrictEqual(
      [info.eligible, info.claimed, info.blocked, info.needsHuman, info.readyToMerge],
      [[], [], [], [], []],
    );
  });
});

describe("schedulerStatsOf", () => {
  it("reports the durable workspace limit even with no run in flight", () => {
    const registered = { ...workspace, workspaceLimit: 2 };
    const stats = schedulerStatsOf(
      { workspaces: [registered], failures: [] },
      { globalLimit: 4, perWorkspaceLimit: 4, dailyBudget: 50 },
      initialState,
    );

    assert.deepStrictEqual(stats.perWorkspace, [{ name: workspace.config.name, inFlight: 0, limit: 2 }]);
  });

  it("reports in-flight work for a registered workspace whose input failed", () => {
    const failed = workspaceId("failed");
    const stats = schedulerStatsOf(
      {
        workspaces: [],
        failures: [
          {
            name: failed,
            source: "/repos/failed",
            message: "invalid Workspace input",
            workspaceLimit: 2,
          },
        ],
      },
      { globalLimit: 4, perWorkspaceLimit: 4, dailyBudget: 50 },
      { ...initialState, global: 1, perWorkspace: new Map([[failed, 1]]) },
    );

    assert.deepStrictEqual(stats.perWorkspace, [{ name: failed, inFlight: 1, limit: 2 }]);
  });
});
