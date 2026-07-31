import { type Claim, WorkItemId } from "@clanker-forge/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { classify } from "./classify";
import type { ObservedItem, PrReview } from "./WorkSource";

const id = Schema.decodeSync(WorkItemId);

const item = (over: Omit<Partial<ObservedItem>, "id"> & { readonly id: string }) => ({
  id: id(over.id),
  title: over.title ?? `item ${over.id}`,
  roles: over.roles ?? [],
  claimLabeled: over.claimLabeled ?? false,
  claim: over.claim ?? null,
  attempts: over.attempts ?? [],
  pr: over.pr ?? null,
});

const pr = (review: PrReview): ObservedItem["pr"] => ({ review });

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
    const { eligible, claimed, blocked } = classify([
      item({ id: "1", roles: ["ready-for-agent"], pr: pr("pending") }),
    ]);
    assert.deepStrictEqual([eligible.length, claimed.length, blocked.length], [0, 0, 0]);
  });

  it("excludes claimed items from eligible and reports them as claimed", () => {
    const claim: Claim = { by: "clanker-forge", claimedAtMillis: 1000 };
    const { eligible, claimed } = classify([item({ id: "1", roles: ["ready-for-agent"], claim })]);
    assert.strictEqual(eligible.length, 0);
    assert.deepStrictEqual(claimed[0]?.claim, claim);
  });

  it("excludes claim-labeled items whose marker is missing to avoid double-claiming", () => {
    const { eligible, claimed, blocked } = classify([
      item({ id: "1", roles: ["ready-for-agent"], claimLabeled: true }),
    ]);
    assert.deepStrictEqual([eligible.length, claimed.length, blocked.length], [0, 0, 0]);
  });

  it("drops terminal wontfix items entirely", () => {
    const { eligible, claimed, blocked } = classify([
      item({ id: "1", roles: ["wontfix", "ready-for-agent"] }),
    ]);
    assert.deepStrictEqual([eligible.length, claimed.length, blocked.length], [0, 0, 0]);
  });

  it("reports needs-info and ready-for-human as blocked with their reason", () => {
    const { blocked } = classify([
      item({ id: "1", roles: ["needs-info"] }),
      item({ id: "2", roles: ["ready-for-human"] }),
    ]);
    const reasons = Object.fromEntries(blocked.map((b) => [b.id, b.reason]));
    assert.strictEqual(reasons["1"], "needs-info");
    assert.strictEqual(reasons["2"], "ready-for-human");
  });

  it("blocks an item as ready-for-human once its stage exhausts the failed-attempt cap", () => {
    const attempt = { stage: "triage" as const, outcome: "failed" as const, atMillis: 1 };
    const { eligible, blocked } = classify([
      item({ id: "1", roles: ["needs-triage"], attempts: [attempt, attempt, attempt] }),
    ]);
    assert.strictEqual(eligible.length, 0);
    assert.strictEqual(blocked[0]?.reason, "ready-for-human");
  });

  it("keeps an item eligible while it is still under the failed-attempt cap", () => {
    const attempt = { stage: "triage" as const, outcome: "failed" as const, atMillis: 1 };
    const { eligible } = classify([item({ id: "1", roles: ["needs-triage"], attempts: [attempt, attempt] })]);
    assert.strictEqual(eligible[0]?.stage, "triage");
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
