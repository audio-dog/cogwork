import type { AttemptRecord, Claim, HandbackRecord } from "@cogwork/contracts";
import type * as Effect from "effect/Effect";

export const defaultClaimant = "cogwork";

export interface CoordinationState {
  readonly claimHeld: boolean;
  readonly claim: Claim | null;
  readonly claimedByUs: boolean;
  readonly attempts: ReadonlyArray<AttemptRecord>;
  readonly handback: HandbackRecord | null;
}

export interface CoordinationAdapter<ReadTarget, WriteTarget, ReleaseToken, Error> {
  readonly read: (target: ReadTarget) => Effect.Effect<CoordinationState, Error>;
  readonly claim: (target: WriteTarget, claim: Claim) => Effect.Effect<void, Error>;
  readonly release: (target: WriteTarget, expected: ReleaseToken) => Effect.Effect<void, Error>;
  readonly appendAttempt: (target: WriteTarget, attempt: AttemptRecord) => Effect.Effect<void, Error>;
  readonly appendHandback: (target: WriteTarget, handback: HandbackRecord) => Effect.Effect<void, Error>;
}
