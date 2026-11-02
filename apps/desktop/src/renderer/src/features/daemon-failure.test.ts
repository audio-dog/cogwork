import { IssueTrackerError } from "@cogwork/contracts";
import * as Cause from "effect/Cause";
import { describe, expect, it } from "vitest";
import { daemonFailureMessage } from "./daemon-failure";

describe("daemonFailureMessage", () => {
  it("shows a typed daemon error message without its cause trace", () => {
    const cause = Cause.fail(
      new IssueTrackerError({
        reason: "unavailable",
        message: "Cannot hand back a work item without a coordination comment",
      }),
    );

    expect(daemonFailureMessage(cause)).toBe("Cannot hand back a work item without a coordination comment");
  });

  it("points to the daemon log when the squashed error has no message", () => {
    expect(daemonFailureMessage(Cause.fail("request rejected"))).toBe(
      "The daemon request failed. Check the daemon log for details.",
    );
  });

  it("points to the daemon log when the error message is empty", () => {
    expect(daemonFailureMessage(Cause.fail(new Error("")))).toBe(
      "The daemon request failed. Check the daemon log for details.",
    );
  });
});
