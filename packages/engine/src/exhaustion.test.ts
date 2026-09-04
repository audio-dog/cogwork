import type { AttemptOutcome, AttemptRecord, HandbackRecord, LifecycleStage } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import { consecutiveFailures, isExhausted, maxAttemptsPerStage } from "./exhaustion";

interface History {
  readonly attempts: ReadonlyArray<AttemptRecord>;
  readonly handback: HandbackRecord | null;
}

const attempt = (
  outcome: AttemptOutcome,
  atMillis: number,
  stage: LifecycleStage = "implement",
): AttemptRecord => ({ stage, outcome, atMillis });

const history = (
  attempts: ReadonlyArray<AttemptRecord>,
  handbackAtMillis: number | null = null,
): History => ({
  attempts,
  handback: handbackAtMillis === null ? null : { by: "maintainer", atMillis: handbackAtMillis },
});

describe("consecutiveFailures", () => {
  it("returns zero when the item has no attempts", () => {
    assert.strictEqual(consecutiveFailures(history([]), "implement"), 0);
  });

  it("counts consecutive failures for the selected stage", () => {
    assert.strictEqual(
      consecutiveFailures(
        history([attempt("failed", 1), attempt("failed", 2), attempt("failed", 3)]),
        "implement",
      ),
      3,
    );
  });

  it("does not count failures from another stage", () => {
    assert.strictEqual(
      consecutiveFailures(
        history([
          attempt("failed", 1, "triage"),
          attempt("failed", 2, "implement"),
          attempt("failed", 3, "follow-up"),
          attempt("failed", 4, "implement"),
        ]),
        "implement",
      ),
      2,
    );
  });

  it("does not let another stage reset the selected stage", () => {
    assert.strictEqual(
      consecutiveFailures(
        history([
          attempt("failed", 1, "implement"),
          attempt("succeeded", 2, "triage"),
          attempt("abandoned", 3, "follow-up"),
          attempt("failed", 4, "implement"),
        ]),
        "implement",
      ),
      2,
    );
  });

  it("resets after success in the selected stage", () => {
    assert.strictEqual(
      consecutiveFailures(
        history([attempt("failed", 1), attempt("failed", 2), attempt("succeeded", 3), attempt("failed", 4)]),
        "implement",
      ),
      1,
    );
  });

  it("resets after abandonment in the selected stage", () => {
    assert.strictEqual(
      consecutiveFailures(
        history([
          attempt("failed", 1),
          attempt("failed", 2),
          attempt("abandoned", 3),
          attempt("failed", 4),
          attempt("failed", 5),
        ]),
        "implement",
      ),
      2,
    );
  });

  it("ignores attempts before the newest handback", () => {
    assert.strictEqual(
      consecutiveFailures(
        history([attempt("failed", 1), attempt("failed", 2), attempt("failed", 3), attempt("failed", 5)], 4),
        "implement",
      ),
      1,
    );
  });

  it("ignores an attempt recorded at the handback boundary", () => {
    assert.strictEqual(
      consecutiveFailures(
        history([attempt("failed", 1), attempt("failed", 2), attempt("failed", 3)], 2),
        "implement",
      ),
      1,
    );
  });

  it("counts all attempts when there is no handback", () => {
    assert.strictEqual(
      consecutiveFailures(
        history([attempt("failed", 1), attempt("failed", 2), attempt("failed", 3)]),
        "implement",
      ),
      3,
    );
  });

  it("applies stage reset rules only after the handback", () => {
    assert.strictEqual(
      consecutiveFailures(
        history(
          [
            attempt("succeeded", 1),
            attempt("failed", 2),
            attempt("failed", 4),
            attempt("succeeded", 5),
            attempt("failed", 6),
          ],
          3,
        ),
        "implement",
      ),
      1,
    );
  });
});

describe("isExhausted", () => {
  it("keeps an item available below the failed-attempt cap", () => {
    assert.isFalse(isExhausted(maxAttemptsPerStage - 1));
  });

  it("spends an item at the failed-attempt cap", () => {
    assert.isTrue(isExhausted(maxAttemptsPerStage));
  });

  it("keeps an item spent above the failed-attempt cap", () => {
    assert.isTrue(isExhausted(maxAttemptsPerStage + 1));
  });
});
