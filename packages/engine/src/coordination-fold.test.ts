import { codingOperation, LineageId } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import { fold, maxAttemptsPerOperation, maxLineageHops } from "./coordination";

const operation = codingOperation("implement");
const root = LineageId.make("issue:1");
const lineage = (hop = 0) => ({ root, parent: null, hop });
const attempt = (outcome: "succeeded" | "failed" | "abandoned", atMillis: number, hop = 0) => ({
  operation,
  outcome,
  atMillis,
  lineage: lineage(hop),
});
const ledger = (
  attempts: ReadonlyArray<ReturnType<typeof attempt>>,
  handbacks: ReadonlyArray<{ by: string; atMillis: number; note: string | null }> = [],
) => ({ claim: null, attempts, handbacks, parks: [], revision: null });

describe("coordination fold", () => {
  const counterCases = [
    {
      name: "counts failures and caps the lineage after the barrier",
      attempts: [
        attempt("failed", 1),
        attempt("failed", 3),
        attempt("failed", 4),
        attempt("failed", 5, maxLineageHops),
      ],
      handbacks: [{ by: "person", atMillis: 2, note: null }],
      expected: {
        consecutiveFailures: maxAttemptsPerOperation,
        exhausted: true,
        hop: maxLineageHops,
        hopCapped: true,
      },
    },
    {
      name: "does not count or reset from another Operation",
      attempts: [
        attempt("failed", 1),
        { ...attempt("succeeded", 2), operation: codingOperation("triage") },
        attempt("failed", 3),
      ],
      handbacks: [],
      expected: { consecutiveFailures: 2, exhausted: false, hop: 0, hopCapped: false },
    },
    {
      name: "resets failures after a non-failure in the same Operation",
      attempts: [attempt("failed", 1), attempt("abandoned", 2), attempt("failed", 3)],
      handbacks: [],
      expected: { consecutiveFailures: 1, exhausted: false, hop: 0, hopCapped: false },
    },
    {
      name: "resets every counter at the handback barrier",
      attempts: [attempt("failed", 1, maxLineageHops)],
      handbacks: [{ by: "person", atMillis: 2, note: null }],
      expected: { consecutiveFailures: 0, exhausted: false, hop: 0, hopCapped: false },
    },
  ] as const;

  counterCases.forEach(({ name, attempts, handbacks, expected }) => {
    it(name, () => {
      assert.deepStrictEqual(fold(ledger(attempts, handbacks), "cogwork").counters(operation), expected);
    });
  });

  it("prioritizes claimed, quiet, parked, then open gates", () => {
    const claim = { by: "cogwork", claimedAtMillis: 4, operation, lineage: lineage() };
    const reason = { _tag: "Stuck", summary: "needs a person" } as const;
    const parked = {
      claim: null,
      attempts: [],
      handbacks: [],
      parks: [{ reason, atMillis: 3 }],
      revision: null,
    };

    assert.strictEqual(fold({ ...parked, claim }, "cogwork").gate(operation)._tag, "Claimed");
    assert.strictEqual(
      fold({ ...parked, revision: { observed: "2", processed: "2" } }, "cogwork").gate(operation)._tag,
      "Quiet",
    );
    assert.strictEqual(fold(parked, "cogwork").gate(operation)._tag, "Parked");
    assert.strictEqual(fold(parked, "cogwork").gate(operation, "2")._tag, "Parked");
    assert.deepStrictEqual(fold(ledger([attempt("failed", 1, maxLineageHops)]), "cogwork").gate(operation), {
      _tag: "Parked",
      reason: { _tag: "HopCap" },
    });
    assert.deepStrictEqual(
      fold(ledger([attempt("failed", 1), attempt("failed", 2), attempt("failed", 3)]), "cogwork").gate(
        operation,
      ),
      { _tag: "Parked", reason: { _tag: "Exhausted", reason: "failure limit" } },
    );
    assert.strictEqual(fold(ledger([]), "cogwork").gate(operation)._tag, "Open");
  });

  const revisionRetryCases = [
    {
      name: "plan rejection",
      reason: { _tag: "PlanRejected", reason: "Granola note has no transcript" },
    },
    { name: "missing operation", reason: { _tag: "MissingOperation" } },
  ] as const;

  revisionRetryCases.forEach(({ name, reason }) => {
    it(`does not block a later revision after ${name}`, () => {
      const view = fold(
        {
          claim: null,
          attempts: [],
          handbacks: [],
          parks: [{ reason, atMillis: 1 }],
          revision: { observed: "2", processed: "1" },
        },
        "cogwork",
      );

      assert.strictEqual(view.gate(operation)._tag, "Open");
    });
  });
});
