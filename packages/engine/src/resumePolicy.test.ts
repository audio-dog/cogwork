import { SessionId } from "@clanker-forge/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { decideResume, type ResumeInputs } from "./resumePolicy";

const session = Schema.decodeSync(SessionId)("sess-1");

const inputs = (over: Partial<ResumeInputs> = {}): ResumeInputs => ({
  sessionId: session,
  lastRunStartedAtMillis: 1_000,
  lastRunTotalTokens: 100,
  now: 2_000,
  worktreeRecreated: false,
  fresh: false,
  maxAgeMillis: 10_000,
  maxTokens: 1_000,
  ...over,
});

describe("decideResume", () => {
  it("resumes when the session is fresh enough on every axis", () => {
    assert.deepStrictEqual(decideResume(inputs()), { kind: "resume", sessionId: session });
  });

  it("starts fresh when there is no stored session", () => {
    assert.deepStrictEqual(decideResume(inputs({ sessionId: null })), {
      kind: "fresh",
      reason: "no-session",
    });
  });

  it("starts fresh when the newest human comment asked for it", () => {
    assert.deepStrictEqual(decideResume(inputs({ fresh: true })), {
      kind: "fresh",
      reason: "fresh-requested",
    });
  });

  it("starts fresh when the worktree was recreated", () => {
    assert.deepStrictEqual(decideResume(inputs({ worktreeRecreated: true })), {
      kind: "fresh",
      reason: "worktree-recreated",
    });
  });

  it("starts fresh when the session aged past the limit", () => {
    assert.deepStrictEqual(decideResume(inputs({ now: 20_000 })), { kind: "fresh", reason: "stale" });
  });

  it("ignores age when no age limit is configured", () => {
    assert.strictEqual(decideResume(inputs({ now: 1_000_000, maxAgeMillis: null })).kind, "resume");
  });

  it("starts fresh when the session ran past the token limit", () => {
    assert.deepStrictEqual(decideResume(inputs({ lastRunTotalTokens: 5_000 })), {
      kind: "fresh",
      reason: "token-limit",
    });
  });

  it("cannot apply the token limit when usage is unavailable", () => {
    assert.strictEqual(decideResume(inputs({ lastRunTotalTokens: null })).kind, "resume");
  });

  it("prefers an explicit fresh request over other fresh reasons", () => {
    assert.deepStrictEqual(decideResume(inputs({ fresh: true, worktreeRecreated: true, now: 20_000 })), {
      kind: "fresh",
      reason: "fresh-requested",
    });
  });
});
