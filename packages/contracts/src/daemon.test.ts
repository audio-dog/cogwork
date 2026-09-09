import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { ControlStoreFailure, PollState } from "./daemon";

describe("ControlStoreFailure", () => {
  it("keeps legacy wire failures retryable", () => {
    const failure = Schema.decodeSync(ControlStoreFailure)({
      _tag: "ControlStoreFailure",
      operation: "read Control store",
      message: "unavailable",
    });

    assert.isTrue(failure.retryable);
  });
});

describe("PollState", () => {
  it("folds and guards every poll status", () => {
    const label = (poll: PollState) =>
      PollState.match(poll, {
        ok: () => "ok",
        pending: () => "pending",
        paused: ({ reason }) => reason,
      });
    const ok: PollState = { status: "ok" };
    const pending: PollState = { status: "pending" };
    const paused: PollState = {
      status: "paused",
      reason: "auth",
      message: "Reconnect",
      retryAtMillis: null,
    };

    assert.strictEqual(label(ok), "ok");
    assert.strictEqual(label(pending), "pending");
    assert.strictEqual(label(paused), "auth");
    assert.isTrue(PollState.guards.ok(ok));
    assert.isTrue(PollState.guards.pending(pending));
    assert.isTrue(PollState.guards.paused(paused));
  });
});
