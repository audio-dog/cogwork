import { NeedIdentity } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { RunPlanRejection, resolvePreflight } from "./run-plan-resolution";
import { harnessName } from "./testing/run-plan-fixtures";

const need = Schema.decodeSync(NeedIdentity)("github");

describe("resolvePreflight", () => {
  it.each([
    {
      name: "no Harness",
      facts: { harness: null, missingNeeds: [], preflightFailure: null },
      reason: RunPlanRejection.NoHarness(),
    },
    {
      name: "a missing need",
      facts: { harness: harnessName, missingNeeds: [need], preflightFailure: null },
      reason: RunPlanRejection.MissingNeed({ needs: [need] }),
    },
    {
      name: "a failed preflight",
      facts: { harness: harnessName, missingNeeds: [], preflightFailure: "Harness unavailable" },
      reason: RunPlanRejection.PreflightFailed({ message: "Harness unavailable" }),
    },
  ])("rejects the Run Plan for $name", ({ facts, reason }) => {
    assert.deepStrictEqual(resolvePreflight(facts), Result.fail(reason));
  });
});
