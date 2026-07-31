import type { AttemptRecord, Claim } from "@clanker-forge/contracts";
import { assert, describe, it } from "@effect/vitest";
import {
  attemptStatus,
  claimLabel,
  claimStatus,
  coordinationMarkers,
  formatCoordinationBody,
  hasClaimLabel,
  hasLedgerMarker,
  ledgerMarker,
  parseAttempts,
  parseClaim,
  rolesFromLabels,
  serializeAttempt,
  serializeClaim,
  stripMarkers,
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

  it("parses claim and attempts from a single consolidated coordination body", () => {
    const claim: Claim = { by: "clanker-forge", claimedAtMillis: 3 };
    const attempts: ReadonlyArray<AttemptRecord> = [
      { stage: "implement", outcome: "failed", atMillis: 1 },
      { stage: "implement", outcome: "failed", atMillis: 2 },
    ];
    const body = formatCoordinationBody(claimStatus("implement"), [
      ...attempts.map(serializeAttempt),
      serializeClaim(claim),
    ]);
    assert.deepStrictEqual(parseClaim([body]), claim);
    assert.deepStrictEqual(parseAttempts([body]), attempts);
  });

  it("recognizes the ledger marker and strips every marker from proposal text", () => {
    assert.isTrue(hasLedgerMarker(ledgerMarker));
    assert.isFalse(hasLedgerMarker("<!-- clanker-forge:claim by=x at=1 -->"));
    const text = `Hello ${ledgerMarker} world ${serializeClaim({ by: "x", claimedAtMillis: 1 })}`;
    assert.strictEqual(stripMarkers(text).replace(/\s+/g, " ").trim(), "Hello world");
  });

  it("formats a visible status above the hidden markers", () => {
    const claim = serializeClaim({ by: "bot", claimedAtMillis: 1 });
    const body = formatCoordinationBody(claimStatus("triage"), [claim]);
    assert.include(body, "Currently triaging this issue.");
    assert.include(body, "> *This was posted by clanker-forge.*");
    assert.deepStrictEqual(coordinationMarkers(body), [claim]);
    assert.strictEqual(attemptStatus({ stage: "triage", outcome: "failed", atMillis: 1 }), "Last triage attempt failed.");
  });
});
