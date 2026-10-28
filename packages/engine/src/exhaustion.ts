import type { AttemptRecord, HandbackRecord, OperationKey } from "@cogwork/contracts";

export interface ExhaustionHistory {
  readonly attempts: ReadonlyArray<AttemptRecord>;
  readonly handback: HandbackRecord | null;
}

export interface ExhaustionDecision {
  readonly failedAttempts: number;
  readonly exhausted: boolean;
}

export const maxAttemptsPerOperation = 3;

const afterHandback = (attempt: AttemptRecord, handback: HandbackRecord | null) =>
  handback === null || attempt.atMillis > handback.atMillis;

const hasOperationKey = (attempt: AttemptRecord, key: OperationKey) =>
  attempt.workflow === key.workflow && attempt.operation === key.operation;

export const attemptsAfterHandback = (history: ExhaustionHistory, key: OperationKey) =>
  history.attempts.filter(
    (attempt) => hasOperationKey(attempt, key) && afterHandback(attempt, history.handback),
  );

export const consecutiveFailures = (history: ExhaustionHistory, key: OperationKey) => {
  const attempts = attemptsAfterHandback(history, key);
  const lastNonFailure = attempts.findLastIndex((attempt) => attempt.outcome !== "failed");
  return attempts.length - (lastNonFailure + 1);
};

export const isExhausted = (failedAttempts: number) => failedAttempts >= maxAttemptsPerOperation;

export const exhaustionOf = (history: ExhaustionHistory, key: OperationKey) => {
  const failedAttempts = consecutiveFailures(history, key);
  return { failedAttempts, exhausted: isExhausted(failedAttempts) } satisfies ExhaustionDecision;
};
