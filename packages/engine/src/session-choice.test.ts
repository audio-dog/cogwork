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

const expectChoice = (over: Partial<SessionChoiceInputs>, expected: SessionChoice) => {
  assert.deepStrictEqual(decideSessionChoice(inputs(over)), expected);
};

describe("decideSessionChoice", () => {
  it("starts fresh when recovery no longer points at the branch's latest session", () => {
    expectChoice(
      {
        recoverySession: sessionId,
        latestBranchSession: latestBranchSessionId,
      },
      full,
    );
  });

  describe("same-harness × resumes-previous × fresh", () => {
    it("continues the previous session with only the continuation prompt", () => {
      expectChoice({}, continuation);
    });

    it("uses only the full prompt when fresh was requested", () => {
      expectChoice({ fresh: true }, full);
    });

    it("starts fresh when the previous session cannot resume", () => {
      expectChoice({ session: opaqueSession({ handle: null }) }, full);
    });

    it("stays fresh when requested for an unresumable session", () => {
      expectChoice(
        {
          session: opaqueSession({ handle: null }),
          fresh: true,
        },
        full,
      );
    });

    it("uses only the full prompt after a harness switch", () => {
      expectChoice({ session: opaqueSession({ harness: otherHarness }) }, full);
    });

    it("keeps the harness-switch decision when fresh was also requested", () => {
      expectChoice(
        {
          session: opaqueSession({ harness: otherHarness }),
          fresh: true,
        },
        full,
      );
    });

    it("starts fresh when no previous session exists", () => {
      expectChoice({ session: null }, full);
    });
  });

  describe("resume policy", () => {
    it("continues an owned transcript without an opaque handle", () => {
      expectChoice({ session: ownedSession() }, continuation);
    });

    it("starts a new session when an opaque session is stale", () => {
      expectChoice({ now: 20_000 }, full);
    });

    it("starts a new session when an opaque session is over the token limit", () => {
      expectChoice({ lastRunTotalTokens: 2_000 }, full);
    });

    it("does not age out an owned transcript", () => {
      expectChoice(
        {
          session: ownedSession(),
          now: 20_000,
          lastRunTotalTokens: 2_000,
        },
        continuation,
      );
    });

    it("starts a new session after any worktree recreation", () => {
      expectChoice({ worktreeRecreated: true }, full);
    });
  });

  describe("without resume policy", () => {
    it("continues an opaque session before its handle has been captured", () => {
      expectChoice(
        {
          session: opaqueSession({ handle: null }),
          applyResumePolicy: false,
        },
        continuation,
      );
    });

    it("continues despite age, token usage, or a fresh flag", () => {
      expectChoice(
        {
          applyResumePolicy: false,
          now: 20_000,
          lastRunTotalTokens: 2_000,
          fresh: true,
        },
        continuation,
      );
    });

    it("continues across a recreated worktree for runtime-host affinity", () => {
      expectChoice(
        {
          applyResumePolicy: false,
          worktreeRecreated: true,
        },
        continuation,
      );
    });

    it("continues across a recreated worktree for portable affinity", () => {
      expectChoice(
        {
          applyResumePolicy: false,
          sessionAffinity: "portable",
          worktreeRecreated: true,
        },
        continuation,
      );
    });

    it("starts a new session after sandbox lineage is recreated", () => {
      expectChoice(
        {
          applyResumePolicy: false,
          sessionAffinity: "sandbox-lineage",
          worktreeRecreated: true,
        },
        combined,
      );
    });

    it("matches the current fallback when affinity is unavailable", () => {
      expectChoice(
        {
          applyResumePolicy: false,
          sessionAffinity: null,
          worktreeRecreated: true,
        },
        continuation,
      );
    });
  });
});
