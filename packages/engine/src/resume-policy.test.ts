import { assert, describe, it } from "@effect/vitest";
import { decideResume, ResumeDecision, type ResumeInputs, type ResumeReason } from "./resume-policy";

const handle = "cursor-session-1";

const opaque = (over: Partial<ResumeInputs> = {}) =>
  ({
    sessionKind: "opaque-handle",
    handle,
    lastRunStartedAtMillis: 1_000,
    lastRunTotalTokens: 100,
    now: 2_000,
    worktreeRecreated: false,
    fresh: false,
    maxAgeMillis: 10_000,
    maxTokens: 1_000,
    ...over,
  }) satisfies ResumeInputs;

const owned = (over: Partial<ResumeInputs> = {}) =>
  opaque({ sessionKind: "owned-transcript", handle: null, ...over });

const resume = ResumeDecision.Resume({ kind: "resume" });
const fresh = (reason: ResumeReason) => ResumeDecision.Fresh({ kind: "fresh", reason });

describe("decideResume", () => {
  describe("opaque-handle", () => {
    it("resumes when the session is fresh enough on every axis", () => {
      assert.deepStrictEqual(decideResume(opaque()), resume);
    });

    it("starts fresh when there is no stored handle", () => {
      assert.deepStrictEqual(decideResume(opaque({ handle: null })), fresh("no-session"));
    });

    it("starts fresh when the newest human comment asked for it", () => {
      assert.deepStrictEqual(decideResume(opaque({ fresh: true })), fresh("fresh-requested"));
    });

    it("starts fresh when the worktree was recreated", () => {
      assert.deepStrictEqual(decideResume(opaque({ worktreeRecreated: true })), fresh("worktree-recreated"));
    });

    it("starts fresh when the session aged past the limit", () => {
      assert.deepStrictEqual(decideResume(opaque({ now: 20_000 })), fresh("stale"));
    });

    it("ignores age when no age limit is configured", () => {
      assert.isTrue(
        ResumeDecision.$is("Resume")(decideResume(opaque({ now: 1_000_000, maxAgeMillis: null }))),
      );
    });

    it("starts fresh when the session ran past the token limit", () => {
      assert.deepStrictEqual(decideResume(opaque({ lastRunTotalTokens: 5_000 })), fresh("token-limit"));
    });

    it("cannot apply the token limit when usage is unavailable", () => {
      assert.isTrue(ResumeDecision.$is("Resume")(decideResume(opaque({ lastRunTotalTokens: null }))));
    });

    it("prefers an explicit fresh request over other fresh reasons", () => {
      assert.deepStrictEqual(
        decideResume(opaque({ fresh: true, worktreeRecreated: true, now: 20_000 })),
        fresh("fresh-requested"),
      );
    });
  });

  describe("owned-transcript", () => {
    it("resumes by default, with no handle", () => {
      assert.deepStrictEqual(decideResume(owned()), resume);
    });

    it("resumes even when the session aged past the opaque-handle limit", () => {
      assert.deepStrictEqual(decideResume(owned({ now: 20_000 })), resume);
    });

    it("resumes even when the run ran past the opaque-handle token limit", () => {
      assert.deepStrictEqual(decideResume(owned({ lastRunTotalTokens: 5_000 })), resume);
    });

    it("still starts fresh when the newest human comment asked for it", () => {
      assert.deepStrictEqual(decideResume(owned({ fresh: true })), fresh("fresh-requested"));
    });

    it("still starts fresh when the worktree was recreated", () => {
      assert.deepStrictEqual(decideResume(owned({ worktreeRecreated: true })), fresh("worktree-recreated"));
    });
  });

  it("starts fresh when there is no session at all", () => {
    assert.deepStrictEqual(decideResume(opaque({ sessionKind: null, handle: null })), fresh("no-session"));
  });
});
