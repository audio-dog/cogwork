import { LineageId } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import { fold, maxLineageHops } from "./coordination";

const operationOf = (operation: string) => ({ workflow: "workflow", operation });
const operation = operationOf("operate");
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
        consecutiveFailures: 3,
        exhausted: true,
        hop: maxLineageHops,
        hopCapped: true,
      },
    },
    {
      name: "does not count or reset from another Operation",
      attempts: [
        attempt("failed", 1),
        { ...attempt("succeeded", 2), operation: operationOf("verify") },
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
      assert.deepStrictEqual(fold(ledger(attempts, handbacks), "cogwork", 0).counters(operation), expected);
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

    assert.strictEqual(fold({ ...parked, claim }, "cogwork", 0).gate(operation)._tag, "Claimed");
    assert.strictEqual(
      fold({ ...parked, revision: { observed: "2", processed: "2" } }, "cogwork", 0).gate(operation)._tag,
      "Quiet",
    );
    assert.strictEqual(fold(parked, "cogwork", 0).gate(operation)._tag, "Parked");
    assert.strictEqual(fold(parked, "cogwork", 0).gate(operation, "2")._tag, "Parked");
    assert.deepStrictEqual(
      fold(ledger([attempt("failed", 1, maxLineageHops)]), "cogwork", 0).gate(operation),
      {
        _tag: "Parked",
        reason: { _tag: "HopCap" },
      },
    );
    assert.strictEqual(
      fold(ledger([attempt("failed", 1), attempt("failed", 2), attempt("failed", 3)]), "cogwork", 0).gate(
        operation,
      )._tag,
      "Open",
    );
    assert.strictEqual(fold(ledger([]), "cogwork", 0).gate(operation)._tag, "Open");
  });

  const retryDelayCases = [
    {
      name: "waits one minute after the first failure",
      attempts: [attempt("failed", 1)],
      handbacks: [],
      cases: [
        { nowMillis: 1, gate: { _tag: "AwaitingRetry", retryAtMillis: 60_001 } },
        { nowMillis: 60_000, gate: { _tag: "AwaitingRetry", retryAtMillis: 60_001 } },
        { nowMillis: 60_001, gate: { _tag: "Open" } },
      ],
    },
    {
      name: "waits two minutes after the second failure",
      attempts: [attempt("failed", 1), attempt("failed", 2)],
      handbacks: [],
      cases: [
        { nowMillis: 60_001, gate: { _tag: "AwaitingRetry", retryAtMillis: 120_002 } },
        { nowMillis: 120_002, gate: { _tag: "Open" } },
      ],
    },
    {
      name: "clears the delay after a later success",
      attempts: [attempt("failed", 1), attempt("succeeded", 2)],
      handbacks: [],
      cases: [{ nowMillis: 2, gate: { _tag: "Open" } }],
    },
    {
      name: "clears the delay at a handback",
      attempts: [attempt("failed", 1)],
      handbacks: [{ by: "person", atMillis: 2, note: null }],
      cases: [{ nowMillis: 2, gate: { _tag: "Open" } }],
    },
  ] as const;

  retryDelayCases.forEach(({ name, attempts, handbacks, cases }) => {
    it(name, () => {
      cases.forEach(({ nowMillis, gate }) => {
        assert.deepStrictEqual(fold(ledger(attempts, handbacks), "cogwork", nowMillis).gate(operation), gate);
      });
    });
  });

  it("delays the failed revision after an earlier revision was processed", () => {
    const view = fold(
      { ...ledger([attempt("failed", 1)]), revision: { observed: "2", processed: "1" } },
      "cogwork",
      1,
    );

    assert.deepStrictEqual(view.gate(operation, "2"), { _tag: "AwaitingRetry", retryAtMillis: 60_001 });
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
        0,
      );

      assert.strictEqual(view.gate(operation, "1")._tag, "Parked");
      assert.strictEqual(view.gate(operation, "2")._tag, "Open");
    });
  });

  it("keeps the parked Operation blocked until the tracker source revision changes", () => {
    const judge = operationOf("judge");
    const view = fold(
      {
        claim: null,
        attempts: [],
        handbacks: [],
        parks: [
          {
            reason: { _tag: "AwaitingApproval", plan: "plan", digest: "digest", revision: "1" },
            operation,
            atMillis: 1,
          },
        ],
        revision: null,
      },
      "cogwork",
      0,
    );

    assert.strictEqual(view.gate(operation, "1")._tag, "Parked");
    assert.strictEqual(view.gate(judge, "sweep-revision")._tag, "Open");
    assert.strictEqual(view.gate(operation, "tracker-revision")._tag, "Open");
  });
});
