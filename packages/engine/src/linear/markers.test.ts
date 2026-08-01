import type { AttemptRecord, Claim } from "@clanker-forge/contracts";
import { assert, describe, it } from "@effect/vitest";
import {
  claimLabel,
  defaultRoleLabels,
  formatCoordinationBody,
  hasClaimLabel,
  hasLedgerMarker,
  parseAttempts,
  parseClaim,
  roleLabelsFor,
  rolesFrom,
  serializeAttempt,
  serializeClaim,
} from "./markers";

describe("linear markers", () => {
  it("defaults role labels to the colony state: convention", () => {
    assert.deepStrictEqual(roleLabelsFor(), defaultRoleLabels);
    assert.strictEqual(
      roleLabelsFor({ "ready-for-agent": "custom:ready" })["ready-for-agent"],
      "custom:ready",
    );
  });

  it("maps labels through config and treats Canceled as wontfix", () => {
    const roles = rolesFrom(
      ["state:ready-for-agent", "bug"],
      { name: "Canceled", type: "canceled" },
      defaultRoleLabels,
    );
    assert.deepStrictEqual(roles, ["ready-for-agent", "wontfix"]);
    const renamed = rolesFrom(
      ["state:ready-for-agent"],
      { name: "Won't do", type: "canceled" },
      defaultRoleLabels,
    );
    assert.deepStrictEqual(renamed, ["ready-for-agent", "wontfix"]);
  });

  it("detects the claim label", () => {
    assert.isTrue(hasClaimLabel(["bug", claimLabel]));
    assert.isFalse(hasClaimLabel(["bug"]));
  });

  it("round-trips a claim through visible plain-text lines", () => {
    const claim: Claim = { by: "clanker-forge", claimedAtMillis: 1_722_000_000_000 };
    const body = formatCoordinationBody({
      status: "Currently implementing this issue.",
      markers: [serializeClaim(claim)],
      detail: null,
    });
    assert.isTrue(hasLedgerMarker(body));
    assert.isFalse(body.includes("<!--"));
    assert.deepStrictEqual(parseClaim([body]), claim);
  });

  it("round-trips attempts and keeps the latest claim", () => {
    const older: Claim = { by: "old", claimedAtMillis: 1 };
    const newer: Claim = { by: "new", claimedAtMillis: 2 };
    const attempts: ReadonlyArray<AttemptRecord> = [
      { stage: "triage", outcome: "failed", atMillis: 3 },
      { stage: "implement", outcome: "succeeded", atMillis: 4 },
    ];
    const body = formatCoordinationBody({
      status: "implement completed.",
      markers: [serializeClaim(older), serializeClaim(newer), ...attempts.map(serializeAttempt)],
      detail: "hand-off note",
    });
    assert.deepStrictEqual(parseClaim([body]), newer);
    assert.deepStrictEqual(parseAttempts([body]), attempts);
  });

  it("rejects malformed claim lines", () => {
    assert.isNull(parseClaim(["just a comment", "clanker-forge:claim by= at=nope"]));
  });
});
