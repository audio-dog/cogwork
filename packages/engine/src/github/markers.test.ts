import type { AttemptRecord, Claim } from "@clanker-forge/contracts";
import { assert, describe, it } from "@effect/vitest";
import type { FollowUpMarker } from "../followUp";
import {
  claimLabel,
  hasClaimLabel,
  parseAttempts,
  parseClaim,
  parseFollowUp,
  rolesFromLabels,
  serializeAttempt,
  serializeClaim,
  serializeFollowUp,
} from "./markers";

describe("github markers", () => {
  it("maps only recognized tracker labels to canonical roles", () => {
    const roles = rolesFromLabels(["ready-for-agent", "needs-info", "priority-high", "wontfix"]);
    assert.deepStrictEqual([...roles].sort(), ["needs-info", "ready-for-agent", "wontfix"]);
  });

  it("detects the claim label", () => {
    assert.isTrue(hasClaimLabel(["bug", claimLabel]));
    assert.isFalse(hasClaimLabel(["bug"]));
  });

  it("round-trips a claim through its hidden comment marker", () => {
    const claim: Claim = { by: "clanker-forge", claimedAtMillis: 1_722_000_000_000 };
    const parsed = parseClaim([`On it.\n${serializeClaim(claim)}\n`]);
    assert.deepStrictEqual(parsed, claim);
  });

  it("round-trips attempt records and preserves their order", () => {
    const attempts: ReadonlyArray<AttemptRecord> = [
      { stage: "implement", outcome: "failed", atMillis: 1 },
      { stage: "follow-up", outcome: "succeeded", atMillis: 2 },
    ];
    const bodies = attempts.map((attempt) => serializeAttempt(attempt));
    assert.deepStrictEqual(parseAttempts(bodies), attempts);
  });

  it("keeps only the most recent claim when several markers exist", () => {
    const older: Claim = { by: "old", claimedAtMillis: 1 };
    const newer: Claim = { by: "new", claimedAtMillis: 2 };
    const parsed = parseClaim([serializeClaim(older), serializeClaim(newer)]);
    assert.deepStrictEqual(parsed, newer);
  });

  it("returns null for bodies without a well-formed claim marker", () => {
    assert.isNull(parseClaim(["just a comment", "<!-- clanker-forge:claim by= at=nope -->"]));
  });

  it("round-trips a follow-up marker and keeps the most recent one", () => {
    const older: FollowUpMarker = { checks: "failing", humanCommentAtMillis: 1, noProgress: 0 };
    const newer: FollowUpMarker = { checks: "passing", humanCommentAtMillis: 2, noProgress: 1 };
    assert.deepStrictEqual(parseFollowUp([serializeFollowUp(older), serializeFollowUp(newer)]), newer);
  });

  it("returns null for a follow-up marker with an unknown check state", () => {
    assert.isNull(parseFollowUp(["<!-- clanker-forge:follow-up checks=maybe human=1 noProgress=0 -->"]));
  });
});
