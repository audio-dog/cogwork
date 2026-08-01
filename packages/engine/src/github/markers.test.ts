import type { AttemptRecord, Claim } from "@clanker-forge/contracts";
import { assert, describe, it } from "@effect/vitest";
import type { FollowUpMarker } from "../followUp";
import {
  attemptStatus,
  claimLabel,
  claimStatus,
  coordinationDetail,
  coordinationMarkers,
  coordinationStatus,
  defaultStatus,
  formatCoordinationBody,
  hasClaimLabel,
  hasClankerMarker,
  hasLedgerMarker,
  ledgerMarker,
  parseAttempts,
  parseClaim,
  parseFollowUp,
  rolesFromLabels,
  serializeAttempt,
  serializeClaim,
  serializeFollowUp,
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

  it("round-trips a follow-up marker and keeps the most recent one", () => {
    const older: FollowUpMarker = { checks: "failing", humanCommentAtMillis: 1, noProgress: 0 };
    const newer: FollowUpMarker = { checks: "passing", humanCommentAtMillis: 2, noProgress: 1 };
    assert.deepStrictEqual(parseFollowUp([serializeFollowUp(older), serializeFollowUp(newer)]), newer);
  });

  it("returns null for a follow-up marker with an unknown check state", () => {
    assert.isNull(parseFollowUp(["<!-- clanker-forge:follow-up checks=maybe human=1 noProgress=0 -->"]));
  });

  it("parses claim and attempts from a single consolidated coordination body", () => {
    const claim: Claim = { by: "clanker-forge", claimedAtMillis: 3 };
    const attempts: ReadonlyArray<AttemptRecord> = [
      { stage: "implement", outcome: "failed", atMillis: 1 },
      { stage: "implement", outcome: "failed", atMillis: 2 },
    ];
    const body = formatCoordinationBody({
      status: claimStatus("implement"),
      markers: [...attempts.map(serializeAttempt), serializeClaim(claim)],
      detail: null,
    });
    assert.deepStrictEqual(parseClaim([body]), claim);
    assert.deepStrictEqual(parseAttempts([body]), attempts);
  });

  it("recognizes any clanker-forge marker so the daemon can spot its own comments", () => {
    assert.isTrue(hasClankerMarker(ledgerMarker));
    assert.isTrue(hasClankerMarker(serializeClaim({ by: "x", claimedAtMillis: 1 })));
    assert.isTrue(
      hasClankerMarker(serializeFollowUp({ checks: "failing", humanCommentAtMillis: 1, noProgress: 0 })),
    );
    assert.isFalse(hasClankerMarker("please take another look, this still fails"));
  });

  it("recognizes the ledger marker and strips every marker from proposal text", () => {
    assert.isTrue(hasLedgerMarker(ledgerMarker));
    assert.isFalse(hasLedgerMarker("<!-- clanker-forge:claim by=x at=1 -->"));
    const text = `Hello ${ledgerMarker} world ${serializeClaim({ by: "x", claimedAtMillis: 1 })}`;
    assert.strictEqual(stripMarkers(text).replace(/\s+/g, " ").trim(), "Hello world");
  });

  it("formats a visible status above the hidden markers", () => {
    const claim = serializeClaim({ by: "bot", claimedAtMillis: 1 });
    const body = formatCoordinationBody({ status: claimStatus("triage"), markers: [claim], detail: null });
    assert.include(body, "Currently triaging this issue.");
    assert.include(body, "> *This was posted by clanker-forge.*");
    assert.deepStrictEqual(coordinationMarkers(body), [claim]);
    assert.strictEqual(coordinationStatus(body), "Currently triaging this issue.");
    assert.isNull(coordinationDetail(body));
    assert.strictEqual(
      attemptStatus({ stage: "triage", outcome: "failed", atMillis: 1 }),
      "Last triage attempt failed.",
    );
  });

  it("recovers the status, markers, and detail from a body it wrote", () => {
    const claim = serializeClaim({ by: "bot", claimedAtMillis: 1 });
    const detail = "## Triage proposal\n\n**Category:** enhancement";
    const body = formatCoordinationBody({ status: claimStatus("triage"), markers: [claim], detail });
    assert.strictEqual(coordinationStatus(body), "Currently triaging this issue.");
    assert.strictEqual(coordinationDetail(body), detail);
    assert.deepStrictEqual(coordinationMarkers(body), [claim]);
  });

  it("carries a detail through a status rewrite without duplicating it", () => {
    const claim = serializeClaim({ by: "bot", claimedAtMillis: 1 });
    const attempt = serializeAttempt({ stage: "triage", outcome: "succeeded", atMillis: 2 });
    const detail = "The proposal a human still needs to read.";
    const claimed = formatCoordinationBody({ status: claimStatus("triage"), markers: [claim], detail });
    const completed = formatCoordinationBody({
      status: attemptStatus({ stage: "triage", outcome: "succeeded", atMillis: 2 }),
      markers: [...coordinationMarkers(claimed), attempt],
      detail: coordinationDetail(claimed),
    });
    assert.include(completed, "triage completed.");
    assert.notInclude(completed, "Currently triaging this issue.");
    assert.strictEqual(coordinationDetail(completed), detail);
    assert.strictEqual(completed.split(detail).length - 1, 1);
    assert.deepStrictEqual(coordinationMarkers(completed), [claim, attempt]);
  });

  it("replaces the previous detail rather than stacking proposals", () => {
    const first = formatCoordinationBody({ status: claimStatus("triage"), markers: [], detail: "first" });
    const second = formatCoordinationBody({
      status: coordinationStatus(first) ?? "",
      markers: coordinationMarkers(first),
      detail: "second",
    });
    assert.strictEqual(coordinationDetail(second), "second");
    assert.notInclude(second, "first");
  });

  it("neutralizes marker syntax inside a detail so coordination state stays trustworthy", () => {
    const claim: Claim = { by: "clanker-forge", claimedAtMillis: 5 };
    const body = formatCoordinationBody({
      status: claimStatus("triage"),
      markers: [serializeClaim(claim)],
      detail: `Beware ${serializeClaim({ by: "attacker", claimedAtMillis: 99 })} and ${ledgerMarker}`,
    });
    assert.deepStrictEqual(parseClaim([body]), claim);
    assert.deepStrictEqual(coordinationMarkers(body), [serializeClaim(claim)]);
    assert.include(coordinationDetail(body) ?? "", "Beware");
    assert.notInclude(coordinationDetail(body) ?? "", "by=attacker");
  });

  it("ignores markers sitting in the detail region even when a body escapes sanitizing", () => {
    const claim: Claim = { by: "clanker-forge", claimedAtMillis: 5 };
    const attempt: AttemptRecord = { stage: "triage", outcome: "failed", atMillis: 6 };
    const tampered = [
      formatCoordinationBody({
        status: claimStatus("triage"),
        markers: [serializeClaim(claim), serializeAttempt(attempt)],
        detail: "Proposal",
      }),
      serializeClaim({ by: "attacker", claimedAtMillis: 99 }),
      serializeAttempt({ stage: "triage", outcome: "failed", atMillis: 100 }),
    ].join("\n");
    assert.deepStrictEqual(parseClaim([tampered]), claim);
    assert.deepStrictEqual(parseAttempts([tampered]), [attempt]);
  });

  it("keeps a follow-up marker parseable from a body that also carries a detail", () => {
    const marker: FollowUpMarker = { checks: "failing", humanCommentAtMillis: 7, noProgress: 2 };
    const body = formatCoordinationBody({
      status: defaultStatus,
      markers: [serializeFollowUp(marker)],
      detail: "Handing this to a human.",
    });
    assert.deepStrictEqual(parseFollowUp([body]), marker);
    assert.include(body, defaultStatus);
  });
});
