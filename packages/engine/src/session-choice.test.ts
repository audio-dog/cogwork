import {
  HarnessName,
  type OpaqueHandleSession,
  type OwnedTranscriptSession,
  SessionId,
  WorkspaceId,
} from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { decideSessionChoice, SessionChoice, type SessionChoiceInputs } from "./session-choice";

const selectedHarness = Schema.decodeSync(HarnessName)("codex");
const otherHarness = Schema.decodeSync(HarnessName)("claude-code");
const workspace = Schema.decodeSync(WorkspaceId)("workspace");
const sessionId = Schema.decodeSync(SessionId)("session-1");
const latestBranchSessionId = Schema.decodeSync(SessionId)("session-2");

const opaqueSession = (over: Partial<OpaqueHandleSession> = {}) =>
  ({
    kind: "opaque-handle",
    id: sessionId,
    workspace,
    harness: selectedHarness,
    createdAtMillis: 500,
    handle: "native-session-1",
    ...over,
  }) satisfies OpaqueHandleSession;

const ownedSession = (over: Partial<OwnedTranscriptSession> = {}) =>
  ({
    kind: "owned-transcript",
    id: sessionId,
    workspace,
    harness: selectedHarness,
    createdAtMillis: 500,
    ...over,
  }) satisfies OwnedTranscriptSession;

const inputs = (over: Partial<SessionChoiceInputs> = {}) =>
  ({
    session: opaqueSession(),
    recoverySession: null,
    latestBranchSession: sessionId,
    selectedHarness,
    sessionAffinity: "runtime-host",
    applyResumePolicy: true,
    lastRunStartedAtMillis: 1_000,
    lastRunTotalTokens: 100,
    now: 2_000,
    worktreeRecreated: false,
    fresh: false,
    maxAgeMillis: 10_000,
    maxTokens: 1_000,
    ...over,
  }) satisfies SessionChoiceInputs;

const continuation = SessionChoice.Continuation({
  session: sessionId,
  prompt: "continuation",
});

const combined = SessionChoice.Combined({
  session: null,
  prompt: "combined",
});

const full = SessionChoice.FreshRecovery({
  session: null,
  prompt: "full",
});

const choose = (over: Partial<SessionChoiceInputs>) => decideSessionChoice(inputs(over));

describe("decideSessionChoice", () => {
  it("starts fresh when recovery no longer points at the branch's latest session", () => {
    assert.deepStrictEqual(
      choose({
        recoverySession: sessionId,
        latestBranchSession: latestBranchSessionId,
      }),
      full,
    );
  });

  describe("same-harness × resumes-previous × fresh", () => {
    it("continues the previous session with only the continuation prompt", () => {
      assert.deepStrictEqual(choose({}), continuation);
    });

    it("uses only the full prompt when fresh was requested", () => {
      assert.deepStrictEqual(choose({ fresh: true }), full);
    });

    it("starts fresh when the previous session cannot resume", () => {
      assert.deepStrictEqual(choose({ session: opaqueSession({ handle: null }) }), full);
    });

    it("stays fresh when requested for an unresumable session", () => {
      assert.deepStrictEqual(
        choose({
          session: opaqueSession({ handle: null }),
          fresh: true,
        }),
        full,
      );
    });

    it("uses only the full prompt after a harness switch", () => {
      assert.deepStrictEqual(choose({ session: opaqueSession({ harness: otherHarness }) }), full);
    });

    it("keeps the harness-switch decision when fresh was also requested", () => {
      assert.deepStrictEqual(
        choose({
          session: opaqueSession({ harness: otherHarness }),
          fresh: true,
        }),
        full,
      );
    });

    it("starts fresh when no previous session exists", () => {
      assert.deepStrictEqual(choose({ session: null }), full);
    });
  });

  describe("resume policy", () => {
    it("continues an owned transcript without an opaque handle", () => {
      assert.deepStrictEqual(choose({ session: ownedSession() }), continuation);
    });

    it("starts a new session when an opaque session is stale", () => {
      assert.deepStrictEqual(choose({ now: 20_000 }), full);
    });

    it("starts a new session when an opaque session is over the token limit", () => {
      assert.deepStrictEqual(choose({ lastRunTotalTokens: 2_000 }), full);
    });

    it("does not age out an owned transcript", () => {
      assert.deepStrictEqual(
        choose({
          session: ownedSession(),
          now: 20_000,
          lastRunTotalTokens: 2_000,
        }),
        continuation,
      );
    });

    it("starts a new session after any worktree recreation", () => {
      assert.deepStrictEqual(choose({ worktreeRecreated: true }), full);
    });
  });

  describe("without resume policy", () => {
    it("continues an opaque session before its handle has been captured", () => {
      assert.deepStrictEqual(
        choose({
          session: opaqueSession({ handle: null }),
          applyResumePolicy: false,
        }),
        continuation,
      );
    });

    it("continues despite age, token usage, or a fresh flag", () => {
      assert.deepStrictEqual(
        choose({
          applyResumePolicy: false,
          now: 20_000,
          lastRunTotalTokens: 2_000,
          fresh: true,
        }),
        continuation,
      );
    });

    it("continues across a recreated worktree for runtime-host affinity", () => {
      assert.deepStrictEqual(
        choose({
          applyResumePolicy: false,
          worktreeRecreated: true,
        }),
        continuation,
      );
    });

    it("continues across a recreated worktree for portable affinity", () => {
      assert.deepStrictEqual(
        choose({
          applyResumePolicy: false,
          sessionAffinity: "portable",
          worktreeRecreated: true,
        }),
        continuation,
      );
    });

    it("starts a new session after sandbox lineage is recreated", () => {
      assert.deepStrictEqual(
        choose({
          applyResumePolicy: false,
          sessionAffinity: "sandbox-lineage",
          worktreeRecreated: true,
        }),
        combined,
      );
    });

    it("matches the current fallback when affinity is unavailable", () => {
      assert.deepStrictEqual(
        choose({
          applyResumePolicy: false,
          sessionAffinity: null,
          worktreeRecreated: true,
        }),
        continuation,
      );
    });
  });
});
