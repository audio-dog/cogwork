import { type HarnessName, type Session, type SessionId, sessionHandle } from "@cogwork/contracts";
import * as Data from "effect/Data";
import type { HarnessCapabilityProfile } from "./harness";
import { decideResume, ResumeDecision, type ResumeInputs } from "./resume-policy";

export type SessionChoice = Data.TaggedEnum<{
  Continuation: {
    readonly session: SessionId;
    readonly prompt: "continuation";
    readonly operations: "current";
  };
  Combined: {
    readonly session: null;
    readonly prompt: "combined";
    readonly operations: "current";
  };
  FreshRecovery: {
    readonly session: null;
    readonly prompt: "full";
    readonly operations: "fresh-recovery";
  };
}>;
export const SessionChoice = Data.taggedEnum<SessionChoice>();

export interface SessionChoiceInputs extends Omit<ResumeInputs, "sessionKind" | "handle"> {
  readonly session: Session | null;
  readonly selectedHarness: HarnessName;
  readonly sessionAffinity: HarnessCapabilityProfile["session"]["affinity"] | null;
  readonly applyResumePolicy: boolean;
}

type ResumeFacts = Omit<ResumeInputs, "sessionKind" | "handle">;

const resumePolicyAllows = (session: Session, facts: ResumeFacts) =>
  ResumeDecision.$match(
    decideResume({
      sessionKind: session.kind,
      handle: sessionHandle(session),
      ...facts,
    }),
    {
      Resume: () => true,
      Fresh: () => false,
    },
  );

export const decideSessionChoice = (inputs: SessionChoiceInputs) => {
  const { session, selectedHarness, sessionAffinity, applyResumePolicy, ...resumeFacts } = inputs;
  if (
    !session ||
    session.harness !== selectedHarness ||
    (applyResumePolicy && !resumePolicyAllows(session, resumeFacts))
  ) {
    return SessionChoice.FreshRecovery({
      session: null,
      prompt: "full",
      operations: "fresh-recovery",
    });
  }
  if (resumeFacts.worktreeRecreated && sessionAffinity === "sandbox-lineage") {
    return SessionChoice.Combined({
      session: null,
      prompt: "combined",
      operations: "current",
    });
  }
  return SessionChoice.Continuation({
    session: session.id,
    prompt: "continuation",
    operations: "current",
  });
};
