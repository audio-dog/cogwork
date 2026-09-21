import * as Cause from "effect/Cause";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { describe, expect, it } from "vitest";
import { harnessCheckState, providerMutationFailure } from "./providers";

describe("harnessCheckState", () => {
  it("keeps checking after the request returns until the board publishes the probe", () => {
    const previousResult = AsyncResult.initial<void>();
    const submission = { baselineCheckedAtMillis: 10, previousResult };

    expect(harnessCheckState(10, previousResult, submission)).toEqual({ checking: true, settled: false });
    expect(harnessCheckState(10, AsyncResult.success(undefined), submission)).toEqual({
      checking: true,
      settled: false,
    });
    expect(harnessCheckState(11, AsyncResult.success(undefined), submission)).toEqual({
      checking: false,
      settled: true,
    });
  });

  it("stops checking when the request fails", () => {
    const previousResult = AsyncResult.initial<void>();
    const failed = AsyncResult.failure(Cause.fail(new Error("check failed")));

    expect(harnessCheckState(10, failed, { baselineCheckedAtMillis: 10, previousResult })).toEqual({
      checking: false,
      settled: true,
    });
  });
});

describe("providerMutationFailure", () => {
  it("uses the latest mutation title and ignores its previous atom result", () => {
    const staleFailure = AsyncResult.failure(Cause.fail(new Error("stale check failure")));
    const enablement = {
      kind: "enablement" as const,
      failureTitle: "Cogwork could not change this provider.",
      previousResult: staleFailure,
    };

    expect(providerMutationFailure(staleFailure, enablement)).toBeNull();

    const currentFailure = AsyncResult.failure(Cause.fail(new Error("enablement failed")));
    const failure = providerMutationFailure(currentFailure, enablement);
    expect(failure?.title).toBe("Cogwork could not change this provider.");
    expect(failure?.message).toContain("Error: enablement failed");
  });
});
