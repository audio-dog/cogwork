import { assert, describe, it } from "@effect/vitest";
import * as Coordination from "../coordination";
import { claimLabel, defaultRoleLabels, hasClaimLabel, roleLabelsFor, rolesFrom, wireCodec } from "./markers";

describe("linear markers", () => {
  it("defaults role labels to the state: convention", () => {
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
});

describe("linear wire codec", () => {
  it("encodes markers as visible plain-text lines, never hidden HTML comments", () => {
    assert.strictEqual(wireCodec.encode({ name: "ledger", pairs: "" }), "cogwork:ledger");
    assert.strictEqual(
      wireCodec.encode({ name: "claim", pairs: "by=cogwork at=1" }),
      "cogwork:claim by=cogwork at=1",
    );
    assert.isFalse(wireCodec.encode({ name: "claim", pairs: "by=x at=1" }).includes("<!--"));
  });

  it("reads a marker only at the start of a line, so an indented sample stays inert", () => {
    const body = ["cogwork:ledger", "cogwork:claim by=me at=2", "  cogwork:claim by=x at=9"].join("\n");
    const spans = wireCodec.scan(body);
    assert.deepStrictEqual(
      spans.map((span) => [span.name, span.pairs]),
      [
        ["ledger", ""],
        ["claim", "by=me at=2"],
      ],
    );
  });

  it("carries markers forward through a formatted body, the read-modify-write the tracker relies on", () => {
    const claim = Coordination.serializeClaim(wireCodec, {
      by: "cogwork",
      claimedAtMillis: 1,
      stage: "implement",
    });
    const attempt = Coordination.serializeAttempt(wireCodec, {
      workflow: "coding",
      operation: "implement",
      outcome: "failed",
      atMillis: 2,
    });
    const body = Coordination.formatCoordinationBody(wireCodec, {
      status: "Last implement attempt failed.",
      markers: [claim, attempt],
      detail: null,
    });
    assert.deepStrictEqual(Coordination.coordinationMarkers(wireCodec, body), [claim, attempt]);
    assert.deepStrictEqual(Coordination.parseClaim(wireCodec, body), {
      by: "cogwork",
      claimedAtMillis: 1,
      stage: "implement",
    });
    assert.deepStrictEqual(Coordination.parseAttempts(wireCodec, body), [
      { workflow: "coding", operation: "implement", outcome: "failed", atMillis: 2 },
    ]);
  });
});
