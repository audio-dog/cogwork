import type { AttemptRecord, HandbackRecord, LifecycleStage } from "@cogwork/contracts";

export interface ExhaustionHistory {
  readonly attempts: ReadonlyArray<AttemptRecord>;
  readonly handback: HandbackRecord | null;
}

export const maxAttemptsPerStage = 3;

const afterHandback = (attempt: AttemptRecord, handback: HandbackRecord | null) =>
  handback === null || attempt.atMillis > handback.atMillis;

export const consecutiveFailures = (history: ExhaustionHistory, stage: LifecycleStage) => {
  const attempts = history.attempts.filter(
    (attempt) => attempt.stage === stage && afterHandback(attempt, history.handback),
  );
  const lastNonFailure = attempts.findLastIndex((attempt) => attempt.outcome !== "failed");
  return attempts.length - (lastNonFailure + 1);
};

export const isExhausted = (failedAttempts: number) => failedAttempts >= maxAttemptsPerStage;
