import { type HarnessName, type Session, type SessionId, sessionHandle } from "@cogwork/contracts";
import type { HarnessCapabilityProfile } from "./harness";
import { decideResume } from "./resume-policy";

export type SessionChoice =
  | {
      readonly session: SessionId;
      readonly prompt: "continuation";
      readonly operations: "current";
    }
  | {
      readonly session: null;
      readonly prompt: "combined";
      readonly operations: "current";
    }
  | {
      readonly session: null;
      readonly prompt: "full";
      readonly operations: "fresh-recovery";
    };

export interface SessionChoiceInputs {
  readonly session: Session | null;
  readonly selectedHarness: HarnessName;
  readonly sessionAffinity: HarnessCapabilityProfile["session"]["affinity"] | null;
  readonly applyResumePolicy: boolean;
  readonly lastRunStartedAtMillis: number | null;
  readonly lastRunTotalTokens: number | null;
  readonly now: number;
  readonly worktreeRecreated: boolean;
  readonly fresh: boolean;
  readonly maxAgeMillis: number | null;
  readonly maxTokens: number | null;
}

const continuation = (session: Session) =>
  ({
    session: session.id,
    prompt: "continuation",
    operations: "current",
  }) satisfies SessionChoice;

const combined = () =>
  ({
    session: null,
    prompt: "combined",
    operations: "current",
  }) satisfies SessionChoice;

const full = () =>
  ({
    session: null,
    prompt: "full",
    operations: "fresh-recovery",
  }) satisfies SessionChoice;

const sandboxLineageRecreated = (inputs: SessionChoiceInputs) =>
  inputs.worktreeRecreated && inputs.sessionAffinity === "sandbox-lineage";

const resumable = (inputs: SessionChoiceInputs, session: Session) =>
  decideResume({
    sessionKind: session.kind,
    handle: sessionHandle(session),
    lastRunStartedAtMillis: inputs.lastRunStartedAtMillis,
    lastRunTotalTokens: inputs.lastRunTotalTokens,
    now: inputs.now,
    worktreeRecreated: inputs.worktreeRecreated,
    fresh: inputs.fresh,
    maxAgeMillis: inputs.maxAgeMillis,
    maxTokens: inputs.maxTokens,
  }).kind === "resume";

export const decideSessionChoice = (inputs: SessionChoiceInputs) => {
  const session = inputs.session;
  if (!session || session.harness !== inputs.selectedHarness) return full();
  if (sandboxLineageRecreated(inputs)) return combined();
  if (!inputs.applyResumePolicy) return continuation(session);
  if (!resumable(inputs, session)) return combined();
  return continuation(session);
};
