import { type Claim, WorkItemId } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { classify } from "./classify";
import { followUpNoProgressLimit, type ObservedPr } from "./follow-up";
import type { ObservedItem, PrReview } from "./issue-tracker";

const id = Schema.decodeSync(WorkItemId);

const item = (over: Omit<Partial<ObservedItem>, "id"> & { readonly id: string }) => ({
  id: id(over.id),
  title: over.title ?? `item ${over.id}`,
  roles: over.roles ?? [],
  assignees: over.assignees ?? [],
  claimLabeled: over.claimLabeled ?? false,
  claim: over.claim ?? null,
  claimedByUs: over.claimedByUs ?? false,
  attempts: over.attempts ?? [],
  pr: over.pr ?? null,
  openBlockers: over.openBlockers ?? 0,
  proposal: over.proposal ?? null,
});

const pr = (review: PrReview, over: Partial<ObservedPr> = {}): ObservedItem["pr"] => ({
  number: 1,
  url: "https://github.com/owner/repo/pull/1",
  review,
  checks: "passing",
  latestHumanCommentAtMillis: null,
  latestBotTriggerAtMillis: null,
  fresh: false,
  baseDivergence: "none",
  waitingSinceMillis: 0,
  followUp: null,
  ...over,
});

describe("classify", () => {
  it("routes ready-for-agent with no PR to implement", () => {
    const { eligible } = classify([item({ id: "1", roles: ["ready-for-agent"] })]);
    assert.deepStrictEqual(
      eligible.map((e) => e.stage),
      ["implement"],
    );
  });

  it("routes needs-triage with no PR to triage", () => {
    const { eligible } = classify([item({ id: "1", roles: ["needs-triage"] })]);
    assert.strictEqual(eligible[0]?.stage, "triage");
  });

  it("routes a changes-requested bot PR to follow-up and a ready one to verify", () => {
    const result = classify([
      item({ id: "1", roles: ["ready-for-agent"], pr: pr("changes-requested") }),
      item({ id: "2", roles: ["ready-for-agent"], pr: pr("ready") }),
    ]);
    const stages = Object.fromEntries(result.eligible.map((e) => [e.id, e.stage]));
    assert.strictEqual(stages["1"], "follow-up");
    assert.strictEqual(stages["2"], "verify");
  });

  it("drops in-flight items whose PR is still pending", () => {
    const { eligible, claimed, needsHuman } = classify([
      item({ id: "1", roles: ["ready-for-agent"], pr: pr("pending") }),
    ]);
    assert.deepStrictEqual([eligible.length, claimed.length, needsHuman.length], [0, 0, 0]);
  });

  it("excludes claimed items from eligible and reports them as claimed", () => {
    const claim: Claim = { by: "cogwork", claimedAtMillis: 1000 };
    const { eligible, claimed } = classify([item({ id: "1", roles: ["ready-for-agent"], claim })]);
    assert.strictEqual(eligible.length, 0);
    assert.deepStrictEqual(claimed[0]?.claim, claim);
  });

  it("excludes claim-labeled items whose marker is missing to avoid double-claiming", () => {
    const { eligible, claimed, needsHuman } = classify([
      item({ id: "1", roles: ["ready-for-agent"], claimLabeled: true }),
    ]);
    assert.deepStrictEqual([eligible.length, claimed.length, needsHuman.length], [0, 0, 0]);
  });

  it("drops terminal wontfix items entirely", () => {
    const { eligible, claimed, needsHuman } = classify([
      item({ id: "1", roles: ["wontfix", "ready-for-agent"] }),
    ]);
    assert.deepStrictEqual([eligible.length, claimed.length, needsHuman.length], [0, 0, 0]);
  });

  it("holds a ready-for-agent item with an open blocker out of eligible and reports its blocker count", () => {
    const { eligible, blocked, needsHuman } = classify([
      item({ id: "1", roles: ["ready-for-agent"], openBlockers: 2 }),
    ]);
    assert.strictEqual(eligible.length, 0);
    assert.strictEqual(needsHuman.length, 0);
    assert.deepStrictEqual(blocked, [{ id: id("1"), title: "item 1", openBlockers: 2 }]);
  });

  it("makes the same item eligible once its last blocker closes, with no role change", () => {
    const roles = ["ready-for-agent"] as const;
    const held = classify([item({ id: "1", roles, openBlockers: 1 })]);
    const freed = classify([item({ id: "1", roles, openBlockers: 0 })]);
    assert.strictEqual(held.blocked.length, 1);
    assert.strictEqual(freed.blocked.length, 0);
    assert.strictEqual(freed.eligible[0]?.stage, "implement");
  });

  it("reports an open blocker as blocked even once the stage has exhausted the failed-attempt cap", () => {
    const attempt = { stage: "implement" as const, outcome: "failed" as const, atMillis: 1 };
    const { blocked, needsHuman } = classify([
      item({
        id: "1",
        roles: ["ready-for-agent"],
        openBlockers: 1,
        attempts: [attempt, attempt, attempt],
      }),
    ]);
    assert.strictEqual(needsHuman.length, 0);
    assert.strictEqual(blocked[0]?.openBlockers, 1);
  });

  it("lets an open blocker hold implement without holding triage, follow-up, or verify", () => {
    const { eligible, blocked } = classify([
      item({ id: "1", roles: ["needs-triage"], openBlockers: 1 }),
      item({ id: "2", roles: ["ready-for-agent"], openBlockers: 1, pr: pr("changes-requested") }),
      item({ id: "3", roles: ["ready-for-agent"], openBlockers: 1, pr: pr("ready") }),
    ]);
    assert.deepStrictEqual(
      eligible.map((entry) => entry.stage),
      ["follow-up", "triage", "verify"],
    );
    assert.strictEqual(blocked.length, 0);
  });

  it("keeps a claimed item claimed even while a blocker is open", () => {
    const claim: Claim = { by: "cogwork", claimedAtMillis: 1000, stage: "implement" };
    const { blocked, claimed } = classify([
      item({ id: "1", roles: ["ready-for-agent"], claim, openBlockers: 1 }),
    ]);
    assert.strictEqual(blocked.length, 0);
    assert.deepStrictEqual(claimed[0]?.claim, claim);
  });

  it("reports needs-info and ready-for-human as needs-human with their reason", () => {
    const { needsHuman } = classify([
      item({ id: "1", roles: ["needs-info"] }),
      item({ id: "2", roles: ["ready-for-human"] }),
    ]);
    const reasons = Object.fromEntries(needsHuman.map((entry) => [entry.id, entry.reason]));
    assert.strictEqual(reasons["1"], "needs-info");
    assert.strictEqual(reasons["2"], "ready-for-human");
  });

  it("carries the triage proposal onto a self-halted item and null when there is none", () => {
    const { needsHuman } = classify([
      item({ id: "1", roles: ["needs-info"], proposal: "Which database should this use?" }),
      item({ id: "2", roles: ["ready-for-human"] }),
    ]);
    const proposals = Object.fromEntries(needsHuman.map((entry) => [entry.id, entry.proposal]));
    assert.strictEqual(proposals["1"], "Which database should this use?");
    assert.isNull(proposals["2"]);
  });

  it("hands an item to a human as ready-for-human once its stage exhausts the failed-attempt cap", () => {
    const attempt = { stage: "triage" as const, outcome: "failed" as const, atMillis: 1 };
    const { eligible, needsHuman } = classify([
      item({ id: "1", roles: ["needs-triage"], attempts: [attempt, attempt, attempt] }),
    ]);
    assert.strictEqual(eligible.length, 0);
    assert.strictEqual(needsHuman[0]?.reason, "ready-for-human");
  });

  it("keeps an item eligible while it is still under the failed-attempt cap", () => {
    const attempt = { stage: "triage" as const, outcome: "failed" as const, atMillis: 1 };
    const { eligible } = classify([item({ id: "1", roles: ["needs-triage"], attempts: [attempt, attempt] })]);
    assert.strictEqual(eligible[0]?.stage, "triage");
  });

  it("resets the failed-attempt cap after a successful attempt for that stage", () => {
    const failed = { stage: "triage" as const, outcome: "failed" as const, atMillis: 1 };
    const succeeded = { stage: "triage" as const, outcome: "succeeded" as const, atMillis: 4 };
    const { eligible, needsHuman } = classify([
      item({
        id: "1",
        roles: ["needs-triage"],
        attempts: [failed, failed, failed, succeeded, failed],
      }),
    ]);
    assert.strictEqual(eligible[0]?.stage, "triage");
    assert.strictEqual(eligible[0]?.priorFailures, 1);
    assert.strictEqual(needsHuman.length, 0);
  });

  it("counts only consecutive failures since the last non-failure for the stage", () => {
    const { eligible } = classify([
      item({
        id: "1",
        roles: ["needs-triage"],
        attempts: [
          { stage: "triage", outcome: "failed", atMillis: 1 },
          { stage: "triage", outcome: "failed", atMillis: 2 },
          { stage: "triage", outcome: "succeeded", atMillis: 3 },
          { stage: "triage", outcome: "failed", atMillis: 4 },
          { stage: "triage", outcome: "failed", atMillis: 5 },
        ],
      }),
    ]);
    assert.strictEqual(eligible[0]?.priorFailures, 2);
  });

  it("routes a bot PR with failing checks to follow-up even without a changes-requested review", () => {
    const { eligible } = classify([item({ id: "1", pr: pr("pending", { checks: "failing" }) })]);
    assert.strictEqual(eligible[0]?.stage, "follow-up");
    assert.strictEqual(eligible[0]?.followUp?.checks, "failing");
    assert.strictEqual(eligible[0]?.followUp?.noProgress, 0);
  });

  it("routes a conflicting bot PR to follow-up even with green checks, no review, and no new comment", () => {
    const { eligible } = classify([item({ id: "1", pr: pr("pending", { baseDivergence: "conflict" }) })]);
    assert.strictEqual(eligible[0]?.stage, "follow-up");
    assert.strictEqual(eligible[0]?.followUp?.baseDivergence, "conflict");
    assert.strictEqual(eligible[0]?.followUp?.noProgress, 0);
  });

  it("leaves a merely-behind (clean) bot PR alone rather than routing it to follow-up", () => {
    const { eligible } = classify([item({ id: "1", pr: pr("pending", { baseDivergence: "clean" }) })]);
    assert.strictEqual(eligible.length, 0);
  });

  it("hands a conflict that persists three rounds with no other progress to a human", () => {
    const { eligible } = classify([
      item({
        id: "1",
        pr: pr("pending", {
          baseDivergence: "conflict",
          followUp: {
            checks: "passing",
            humanCommentAtMillis: 0,
            noProgress: followUpNoProgressLimit - 1,
            baseDivergence: "conflict",
            botTriggerAtMillis: 0,
          },
        }),
      }),
    ]);
    assert.strictEqual(eligible[0]?.stage, "follow-up");
    assert.strictEqual(eligible[0]?.followUp?.noProgress, followUpNoProgressLimit);
    assert.isTrue(eligible[0]?.followUp?.stalled);
  });

  it("routes a bot PR with a new human comment and green checks to follow-up", () => {
    const { eligible } = classify([
      item({ id: "1", pr: pr("pending", { checks: "passing", latestHumanCommentAtMillis: 100 }) }),
    ]);
    assert.strictEqual(eligible[0]?.stage, "follow-up");
  });

  it("increments the no-progress counter when neither checks nor human moved since the last attempt", () => {
    const { eligible } = classify([
      item({
        id: "1",
        pr: pr("pending", {
          checks: "failing",
          latestHumanCommentAtMillis: 50,
          followUp: {
            checks: "failing",
            humanCommentAtMillis: 50,
            noProgress: 1,
            baseDivergence: "none",
            botTriggerAtMillis: 0,
          },
        }),
      }),
    ]);
    assert.strictEqual(eligible[0]?.followUp?.noProgress, 2);
    assert.isFalse(eligible[0]?.followUp?.stalled);
  });

  it("resets the no-progress counter when a human responds since the last attempt", () => {
    const { eligible } = classify([
      item({
        id: "1",
        pr: pr("pending", {
          checks: "failing",
          latestHumanCommentAtMillis: 100,
          followUp: {
            checks: "failing",
            humanCommentAtMillis: 50,
            noProgress: 2,
            baseDivergence: "none",
            botTriggerAtMillis: 0,
          },
        }),
      }),
    ]);
    assert.strictEqual(eligible[0]?.followUp?.noProgress, 0);
  });

  it("keeps a no-progress follow-up eligible but flagged stalled at the limit", () => {
    const { eligible } = classify([
      item({
        id: "1",
        pr: pr("pending", {
          checks: "failing",
          latestHumanCommentAtMillis: 50,
          followUp: {
            checks: "failing",
            humanCommentAtMillis: 50,
            noProgress: followUpNoProgressLimit - 1,
            baseDivergence: "none",
            botTriggerAtMillis: 0,
          },
        }),
      }),
    ]);
    assert.strictEqual(eligible[0]?.stage, "follow-up");
    assert.strictEqual(eligible[0]?.followUp?.noProgress, followUpNoProgressLimit);
    assert.isTrue(eligible[0]?.followUp?.stalled);
  });

  it("attaches the PR summary to every bucket that observed one, and leaves the rest bare", () => {
    const claim: Claim = { by: "cogwork", claimedAtMillis: 1 };
    const summary = {
      number: 1,
      url: "https://github.com/owner/repo/pull/1",
      checks: "passing",
      review: "changes-requested",
      baseDivergence: "none",
      waitingSinceMillis: 0,
    };
    const { eligible, claimed, needsHuman } = classify([
      item({ id: "e", roles: ["ready-for-agent"], pr: pr("changes-requested") }),
      item({ id: "c", roles: ["ready-for-agent"], claim, pr: pr("changes-requested") }),
      item({ id: "h", roles: ["ready-for-human"], pr: pr("changes-requested") }),
      item({ id: "bare", roles: ["ready-for-agent"] }),
    ]);
    assert.deepStrictEqual(eligible.find((e) => e.id === id("e"))?.pr, summary);
    assert.deepStrictEqual(claimed[0]?.pr, summary);
    assert.deepStrictEqual(needsHuman[0]?.pr, summary);
    assert.isUndefined(eligible.find((e) => e.id === id("bare"))?.pr);
  });

  it("gates on the assignee allowlist across every stage when one is set", () => {
    const claim: Claim = { by: "cogwork", claimedAtMillis: 1, stage: "implement" };
    const { eligible, claimed, blocked, needsHuman } = classify(
      [
        item({ id: "implement", roles: ["ready-for-agent"], assignees: ["intruder"] }),
        item({ id: "triage", roles: ["needs-triage"], assignees: ["intruder"] }),
        item({
          id: "follow-up",
          roles: ["ready-for-agent"],
          pr: pr("changes-requested"),
          assignees: ["intruder"],
        }),
        item({ id: "verify", roles: ["ready-for-agent"], pr: pr("ready"), assignees: ["intruder"] }),
        item({ id: "claimed", roles: ["ready-for-agent"], claim, assignees: ["intruder"] }),
        item({ id: "blocked", roles: ["ready-for-agent"], openBlockers: 1, assignees: ["intruder"] }),
        item({ id: "human", roles: ["needs-info"], assignees: ["intruder"] }),
      ],
      ["me"],
    );
    assert.deepStrictEqual(
      [eligible.length, claimed.length, blocked.length, needsHuman.length],
      [0, 0, 0, 0],
    );
  });

  it("keeps items whose assignee is on the allowlist", () => {
    const { eligible } = classify(
      [item({ id: "1", roles: ["ready-for-agent"], assignees: ["teammate", "me"] })],
      ["me"],
    );
    assert.strictEqual(eligible[0]?.stage, "implement");
  });

  it("drops an allowlisted workspace's unassigned item", () => {
    const { eligible, claimed, needsHuman } = classify(
      [item({ id: "1", roles: ["ready-for-agent"], assignees: [] })],
      ["me"],
    );
    assert.deepStrictEqual([eligible.length, claimed.length, needsHuman.length], [0, 0, 0]);
  });

  it("ignores assignees entirely when no allowlist is set", () => {
    const { eligible } = classify([item({ id: "1", roles: ["ready-for-agent"], assignees: ["anyone"] })]);
    assert.strictEqual(eligible[0]?.stage, "implement");
  });

  it("orders eligible work follow-up > triage > implement > verify", () => {
    const { eligible } = classify([
      item({ id: "verify", roles: ["ready-for-agent"], pr: pr("ready") }),
      item({ id: "implement", roles: ["ready-for-agent"] }),
      item({ id: "triage", roles: ["needs-triage"] }),
      item({ id: "follow-up", roles: ["ready-for-agent"], pr: pr("changes-requested") }),
    ]);
    assert.deepStrictEqual(
      eligible.map((e) => e.stage),
      ["follow-up", "triage", "implement", "verify"],
    );
  });
});
